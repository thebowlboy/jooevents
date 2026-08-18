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
      slotKey: 'agenda', contentBytesRef: 'files/fixture/agenda',
      filename: 'agenda.pdf', mediaType: 'application/pdf', byteLength: 1,
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

/** Reads an expectation with ordinary spaces against the real non-breaking bytes. */
const span = (text: string): string => text.replaceAll(' ', '\u00a0');

const datedRegistry = createOrganizerMergeRegistryRelease({
  reference: { key: 'merge.registry.dated', version: 1 },
  fields: [
    { fieldKey: 'cfp.closes_at', valueType: 'instant' },
    { fieldKey: 'event.start_date', valueType: 'date' }
  ]
});
const datedRevision = { ...revision, templateId: 'template-dated', digestSha256: 'e'.repeat(64) };
const datedTemplate = {
  revision: datedRevision,
  content: {
    kind: 'email/v1' as const,
    subject: [{ kind: 'text' as const, value: 'Unused template subject' }],
    body: {
      mode: 'composed' as const,
      blocks: [{ kind: 'detail_rows' as const, rows: [
        { label: [{ kind: 'text' as const, value: 'Event starts' }],
          value: [{ kind: 'merge_field' as const, fieldKey: 'event.start_date' }] },
        { label: [{ kind: 'text' as const, value: 'Proposals close' }],
          value: [{ kind: 'merge_field' as const, fieldKey: 'cfp.closes_at' }] }
      ] }]
    },
    plainTextPolicy: 'derive_v1' as const,
    attachmentSlotKeys: []
  },
  fieldBindings: [
    { fieldKey: 'cfp.closes_at', requirement: 'required' as const, fallback: { kind: 'none' as const } },
    { fieldKey: 'event.start_date', requirement: 'required' as const, fallback: { kind: 'none' as const } }
  ]
};

function renderDated(overrides: Record<string, unknown> = {}) {
  return renderOrganizerEmailV1({
    recipientResolutionId: 'rr1_abcdefghijklmnop',
    releaseId: 'release-dated-1',
    releaseDigestSha256: 'b'.repeat(64),
    renderer: definition('renderer.email-v1', 'c'),
    mergeRegistry: datedRegistry,
    messageContent: {
      kind: 'email/v1', subject: 'Your proposal',
      body: { kind: 'template_revision/v1', templateRevision: datedRevision }
    },
    template: datedTemplate,
    resolvedValues: [
      { fieldKey: 'cfp.closes_at', value: { valueType: 'instant', value: '2027-03-18T23:59:00.000Z' } },
      { fieldKey: 'event.start_date', value: { valueType: 'date', value: '2027-08-20' } }
    ],
    ...overrides
  });
}

describe('dates in a rendered message', () => {
  test('a recipient is never sent the machine string, in either body', () => {
    const result = renderDated();
    for (const body of [result.sanitizedHtml, result.plainText]) {
      expect(body).toContain(span('20 Aug 2027'));
      expect(body).toContain(span('18 Mar 2027 \u00b7 23:59 UTC'));
      expect(body).not.toContain('2027-08-20');
      expect(body).not.toContain('2027-03-18T23:59:00.000Z');
      expect(body).not.toContain('Invalid Date');
    }
  });

  test('the non-breaking spaces survive the rendered-output contract', () => {
    // `sanitizedHtml` and `plainText` are validated as canonical text on the way
    // out. A date holds its span together with U+00A0, so if that validator ever
    // collapsed internal whitespace this render would fail rather than reformat.
    const result = renderDated();
    expect(result.plainText).toContain('\u00a0');
    expect(result.sanitizedHtml).toContain('\u00a0');
    // Ordinary spaces in the same place would be a date that can break in half.
    expect(result.plainText).not.toContain('20 Aug 2027');
  });

  test('the event zone moves the clock, the day, and both digests', () => {
    const utc = renderDated();
    const local = renderDated({ timezone: 'America/New_York' });
    expect(local.plainText).toContain(span('18 Mar 2027 · 19:59 EDT'));
    // A date has no clock to move, so it reads the same either way.
    expect(local.plainText).toContain(span('20 Aug 2027'));
    expect(local.outputDigestSha256).not.toBe(utc.outputDigestSha256);
    expect(local.resolvedInputDigestSha256).not.toBe(utc.resolvedInputDigestSha256);
    expect(renderDated({ timezone: 'America/New_York' }).outputDigestSha256)
      .toBe(local.outputDigestSha256);
  });
});
