import { describe, expect, test } from 'bun:test';
import {
  acceptSenderDisplayName,
  acceptSenderReplyToAddress,
  resolveMailSenderPresentation,
  SENDER_DISPLAY_NAME_MAXIMUM_LENGTH
} from '../index';

describe('sender display-name acceptance', () => {
  test('accepts an ordinary name and removes only surrounding spaces', () => {
    expect(acceptSenderDisplayName('  Nordic Product Days  '))
      .toEqual({ kind: 'accepted', value: 'Nordic Product Days' });
  });

  test('refuses CR and LF — the header-injection vector — as control characters', () => {
    for (const injected of [
      'Nordic\r\nBcc: attacker@example.test',
      'Nordic\nBcc: attacker@example.test',
      'Nordic\rDays'
    ]) {
      expect(acceptSenderDisplayName(injected))
        .toEqual({ kind: 'refused', code: 'display_name_control_character' });
    }
  });

  test('refuses every other C0 control and DEL', () => {
    for (const code of [0x00, 0x07, 0x09, 0x0b, 0x1f, 0x7f]) {
      expect(acceptSenderDisplayName(`Nordic${String.fromCharCode(code)}Days`))
        .toEqual({ kind: 'refused', code: 'display_name_control_character' });
    }
  });

  test('refuses the bidi-override and zero-width class the renderer refuses', () => {
    for (const character of ['​', '‎', '‮', '⁦', '⁩']) {
      expect(acceptSenderDisplayName(`Nordic${character}Days`))
        .toEqual({ kind: 'refused', code: 'display_name_bidi_or_zero_width' });
    }
  });

  test('refuses an unpaired surrogate', () => {
    expect(acceptSenderDisplayName('Nordic\ud83d Days'))
      .toEqual({ kind: 'refused', code: 'display_name_unpaired_surrogate' });
  });

  test('bounds length at the one downstream ceiling and refuses a blank name', () => {
    expect(acceptSenderDisplayName('n'.repeat(SENDER_DISPLAY_NAME_MAXIMUM_LENGTH)).kind)
      .toBe('accepted');
    expect(acceptSenderDisplayName('n'.repeat(SENDER_DISPLAY_NAME_MAXIMUM_LENGTH + 1)))
      .toEqual({ kind: 'refused', code: 'display_name_too_long' });
    expect(acceptSenderDisplayName('   '))
      .toEqual({ kind: 'refused', code: 'display_name_empty' });
  });
});
describe('sender reply-to acceptance', () => {
  test('accepts exactly one bare mailbox', () => {
    const accepted = acceptSenderReplyToAddress(' hello@nordic.example ');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('reply_to_not_accepted');
    expect(String(accepted.value)).toBe('hello@nordic.example');
  });

  test('refuses a list, a group, and a display form — never more than one address', () => {
    for (const candidate of [
      'a@nordic.example, b@nordic.example',
      'a@nordic.example; b@nordic.example',
      'Nordic <hello@nordic.example>',
      '"Nordic" <hello@nordic.example>',
      'undisclosed:;'
    ]) {
      expect(acceptSenderReplyToAddress(candidate))
        .toEqual({ kind: 'refused', code: 'reply_to_multiple_addresses' });
    }
  });

  test('refuses CR/LF injection and the bidi/zero-width class', () => {
    expect(acceptSenderReplyToAddress('hello@nordic.example\r\nBcc: attacker@example.test'))
      .toEqual({ kind: 'refused', code: 'reply_to_control_character' });
    expect(acceptSenderReplyToAddress('hello‮@nordic.example'))
      .toEqual({ kind: 'refused', code: 'reply_to_bidi_or_zero_width' });
  });

  test('refuses a value that is not one address', () => {
    for (const candidate of ['nordic.example', '@nordic.example', 'hello@', 'a@b@c']) {
      expect(acceptSenderReplyToAddress(candidate))
        .toEqual({ kind: 'refused', code: 'reply_to_not_one_address' });
    }
    expect(acceptSenderReplyToAddress('')).toEqual({ kind: 'refused', code: 'reply_to_empty' });
    expect(acceptSenderReplyToAddress(`${'a'.repeat(320)}@nordic.example`))
      .toEqual({ kind: 'refused', code: 'reply_to_too_long' });
  });
});

describe('sender presentation resolution', () => {
  const installation = Object.freeze({
    fromAddress: 'no-reply@mail.example.test',
    fromDisplayName: 'JooEvents',
    replyToAddress: 'ops@example.test'
  });

  test('an unset workspace keeps every installation value', () => {
    expect(resolveMailSenderPresentation({ installation, workspace: undefined })).toEqual({
      fromAddress: 'no-reply@mail.example.test',
      fromDisplayName: 'JooEvents',
      replyToAddress: 'ops@example.test',
      source: 'installation'
    });
    expect(resolveMailSenderPresentation({
      installation,
      workspace: { displayName: null, replyToAddress: null }
    }).source).toBe('installation');
  });

  test('workspace values override presentation but never the from-address', () => {
    expect(resolveMailSenderPresentation({
      installation,
      workspace: { displayName: 'Nordic Product Days', replyToAddress: 'hello@nordic.example' }
    })).toEqual({
      fromAddress: 'no-reply@mail.example.test',
      fromDisplayName: 'Nordic Product Days',
      replyToAddress: 'hello@nordic.example',
      source: 'workspace'
    });
  });

  test('each field falls back independently', () => {
    expect(resolveMailSenderPresentation({
      installation,
      workspace: { displayName: 'Nordic Product Days', replyToAddress: null }
    })).toEqual({
      fromAddress: 'no-reply@mail.example.test',
      fromDisplayName: 'Nordic Product Days',
      replyToAddress: 'ops@example.test',
      source: 'workspace'
    });
  });

  test('an installation with no display name and no workspace value renders no display name', () => {
    expect(resolveMailSenderPresentation({
      installation: { fromAddress: 'no-reply@mail.example.test' },
      workspace: { displayName: null, replyToAddress: null }
    })).toEqual({ fromAddress: 'no-reply@mail.example.test', source: 'installation' });
  });
});
describe('a display name may not smuggle a second mailbox', () => {
  test('address punctuation in a name refuses, so one From header names one sender', () => {
    // The composed header puts the name straight beside the address. A name
    // like `Events <billing@elsewhere.test>` would render two angle-addrs and
    // let a reader trust the wrong one.
    for (const hostile of [
      'Events <billing@elsewhere.test>',
      'Events, Billing',
      'Events; Billing',
      'Events "quoted"',
      'Events (comment)',
      'Events [bracket]',
      'Events \\ escape'
    ]) {
      expect(acceptSenderDisplayName(hostile)).toEqual({
        kind: 'refused',
        code: 'display_name_address_syntax'
      });
    }
  });

  test('an ordinary name with punctuation people actually use still passes', () => {
    for (const name of ["JooCon '27 Programme", 'Acme & Co. Events', 'Events – Berlin', 'Résumé Day']) {
      expect(acceptSenderDisplayName(name)).toEqual({ kind: 'accepted', value: name });
    }
  });
});
