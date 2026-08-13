import { describe, expect, test } from 'bun:test';
import { OrganizerEmailRenderError, renderOrganizerEmailV1 } from './email-v1';
import { createOrganizerMergeRegistryRelease } from './merge-registry';

const definition = (key: string, fill: string) => ({
  reference: { key, version: 1 }, definitionDigestSha256: fill.repeat(64)
});
const revision = {
  templateId: 'template-1', templateRevisionId: 'template-revision-1', revisionNumber: 1,
  digestSha256: 'a'.repeat(64)
};
const registry = createOrganizerMergeRegistryRelease({
  reference: { key: 'merge.registry', version: 1 },
  fields: [
    {
      fieldKey: 'event.url',
      valueType: 'url',
      allowedHttpsOrigins: ['https://events.example.test']
    },
    { fieldKey: 'person.first_name', valueType: 'text' }
  ]
});
const template = {
  revision,
  content: {
    kind: 'email/v1' as const,
    subject: [{ kind: 'text' as const, value: 'Unused template subject' }],
    body: {
      mode: 'composed' as const,
      blocks: [
        { kind: 'paragraph' as const, content: [
          { kind: 'text' as const, value: 'Hello' },
          { kind: 'merge_field' as const, fieldKey: 'person.first_name' }
        ] },
        { kind: 'action_link' as const,
          label: [{ kind: 'text' as const, value: 'Open event' }], hrefFieldKey: 'event.url' }
      ]
    },
    plainTextPolicy: 'derive_v1' as const,
    attachmentSlotKeys: []
  },
  fieldBindings: [
    { fieldKey: 'event.url', requirement: 'required' as const, fallback: { kind: 'none' as const } },
    { fieldKey: 'person.first_name', requirement: 'required' as const, fallback: { kind: 'none' as const } }
  ]
};

function render(overrides: Record<string, unknown> = {}) {
  return renderOrganizerEmailV1({
    recipientResolutionId: 'rr1_abcdefghijklmnop',
    releaseId: 'release-1',
    releaseDigestSha256: 'b'.repeat(64),
    renderer: definition('renderer.email-v1', 'c'),
    mergeRegistry: registry,
    messageContent: {
      kind: 'email/v1', subject: 'Arrival <details>',
      body: { kind: 'template_revision/v1', templateRevision: revision }
    },
    template,
    resolvedValues: [
      { fieldKey: 'person.first_name', value: { valueType: 'text', value: '<Maya>' } },
      { fieldKey: 'event.url', value: { valueType: 'url', value: 'https://events.example.test/arrival' } }
    ],
    ...overrides
  });
}

describe('organizer deterministic email renderer', () => {
  test('escapes content, resolves only typed fields, and pins all output digests', () => {
    const first = render();
    const second = render({ resolvedValues: [
      { fieldKey: 'event.url', value: { valueType: 'url', value: 'https://events.example.test/arrival' } },
      { fieldKey: 'person.first_name', value: { valueType: 'text', value: '<Maya>' } }
    ] });
    expect(first.subject).toBe('Arrival <details>');
    expect(first.sanitizedHtml).toContain('Hello&lt;Maya&gt;');
    expect(first.sanitizedHtml).toContain('href="https://events.example.test/arrival"');
    expect(first.sanitizedHtml).not.toContain('<Maya>');
    expect(first.plainText).toContain('Hello<Maya>');
    expect(first.outputDigestSha256).toBe(second.outputDigestSha256);
    expect(first.resolvedInputDigestSha256).toBe(second.resolvedInputDigestSha256);
    expect('providerMessageId' in first).toBe(false);
    expect('recipientAddress' in first).toBe(false);
  });

  test('renders direct plain text without provider or template behavior', () => {
    const result = renderOrganizerEmailV1({
      recipientResolutionId: 'rr1_abcdefghijklmnop', releaseId: 'release-plain-1',
      releaseDigestSha256: 'd'.repeat(64), renderer: definition('renderer.email-v1', 'c'),
      mergeRegistry: registry,
      messageContent: { kind: 'email/v1', subject: 'Hello',
        body: { kind: 'plain_text/v1', text: 'Line <one>\nLine two' } }
    });
    expect(result.sanitizedHtml).toContain('Line &lt;one&gt;<br>Line two');
    expect(result.plainText).toBe('Line <one>\nLine two');
  });

  test('fails closed on missing fields, unsafe URLs, attachment mismatch, and open canvas', () => {
    expect(() => render({ resolvedValues: [] })).toThrow(OrganizerEmailRenderError);
    expect(() => render({ resolvedValues: [
      { fieldKey: 'person.first_name', value: { valueType: 'text', value: 'Maya' } },
      { fieldKey: 'event.url', value: { valueType: 'url', value: 'javascript:alert(1)' } }
    ] })).toThrow(new OrganizerEmailRenderError('unsafe_url'));
    expect(() => render({ resolvedValues: [
      { fieldKey: 'person.first_name', value: { valueType: 'text', value: 'Maya' } },
      { fieldKey: 'event.url', value: { valueType: 'url', value: 'https://other.example.test/' } }
    ] })).toThrow(new OrganizerEmailRenderError('unsafe_url'));
    expect(() => render({ attachments: [{
      slotKey: 'agenda', filename: 'agenda.pdf', mediaType: 'application/pdf', byteLength: 1,
      contentSha256: 'e'.repeat(64), disposition: 'attachment'
    }] })).toThrow(new OrganizerEmailRenderError('attachment_mismatch'));
    expect(() => render({ template: {
      ...template,
      content: { ...template.content, body: {
        mode: 'open_canvas', inertSource: '<p>hello</p>', parameterKeys: [], complianceAnchors: [],
        sanitizerContract: definition('sanitizer.pending', 'f')
      } }
    } })).toThrow(new OrganizerEmailRenderError('open_canvas_not_supported'));
  });
});
