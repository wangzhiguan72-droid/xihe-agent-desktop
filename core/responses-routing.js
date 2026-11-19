'use strict';

// Shared by request dispatch and reasoning audit records so both describe the
// same wire protocol, without coupling the policy to a provider implementation.
function usesResponses(args) {
  if (String(args.kind || '').toLowerCase() === 'responses') return true;
  return args.kind !== 'anthropic' && /^https:\/\/api\.openai\.com\/v1\/?$/i.test(String(args.base || '')) &&
    /^(?:gpt-5(?:[.-]|$)|gpt-6(?:\.1)?-(?:astra|sol|luna)(?:-|$))/i.test(String(args.model || ''));
}

function endpointURL(base, kind) {
  const raw = String(base || '').trim().replace(/\/+$/, '');
  const protocol = String(kind || 'openai').toLowerCase();
  if (!raw) return raw;
  let stem = raw.replace(/\/(?:chat\/completions|responses|messages)$/i, '');
  if (/^https:\/\/api\.openai\.com$/i.test(stem)) stem += '/v1';
  if (protocol === 'responses') return stem + '/responses';
  if (protocol === 'anthropic') return stem + (/\/v1$/i.test(stem) ? '/messages' : '/v1/messages');
  return stem + '/chat/completions';
}

module.exports = { usesResponses, endpointURL };
