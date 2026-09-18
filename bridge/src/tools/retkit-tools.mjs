const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const RETKIT_TOOL_SPECS = [
  { name: 'get_current_html', description: 'Read the current RetKit HTML and freshness hash.', inputSchema: object() },
  { name: 'get_subject', description: 'Read the current MoEngage email subject.', inputSchema: object() },
  { name: 'get_active_locale', description: 'Read the current RetKit/MoEngage locale.', inputSchema: object() },
  { name: 'list_locales', description: 'List locales available in the current MoEngage email.', inputSchema: object() },
  { name: 'list_available_locales', description: 'List additional locales currently offered by the native MoEngage + Locale menu.', inputSchema: object() },
  { name: 'add_locale', description: 'Request adding one locale that MoEngage currently offers. RetKit gates this structural change in the browser.', inputSchema: object({ locale: { type: 'string' } }, ['locale']) },
  { name: 'remove_locale', description: 'Request removing one non-default locale from the current MoEngage campaign. RetKit requires Agent mode and user confirmation.', inputSchema: object({ locale: { type: 'string' } }, ['locale']) },
  { name: 'get_locale_html', description: 'Read one locale HTML. RetKit may temporarily switch locale and restore it.', inputSchema: object({ locale: { type: 'string' } }, ['locale']) },
  { name: 'get_selected_source', description: 'Read the currently selected HTML source fragment.', inputSchema: object() },
  { name: 'get_validator_issues', description: 'Read current RetKit HTML validator issues.', inputSchema: object() },
  { name: 'get_preview_dom', description: 'Read serialized DOM from the current rendered preview.', inputSchema: object({ maxChars: { type: 'number' } }) },
  { name: 'get_preview_screenshot', description: 'Attempt a current preview screenshot; returns an explicit unsupported reason when browser capture is unavailable.', inputSchema: object() },
  { name: 'get_email_context_summary', description: 'Read a compact summary of HTML, subject, locale, selection and validation state.', inputSchema: object() },
  { name: 'switch_locale', description: 'Switch the RetKit/MoEngage editor to a locale.', inputSchema: object({ locale: { type: 'string' } }, ['locale']) },
  { name: 'propose_html_patch', description: 'Propose complete replacement HTML based on a freshness hash. The user must approve it in RetKit.', inputSchema: object({ baseHash: { type: 'string' }, html: { type: 'string' }, summary: { type: 'string' } }, ['baseHash', 'html']) },
  { name: 'propose_subject_change', description: 'Propose a subject change. The user must approve it in RetKit.', inputSchema: object({ baseSubject: { type: 'string' }, subject: { type: 'string' }, summary: { type: 'string' } }, ['baseSubject', 'subject']) },
];

export const RETKIT_TOOL_NAMES = RETKIT_TOOL_SPECS.map((tool) => tool.name);
export function codexDynamicTools() { return RETKIT_TOOL_SPECS.map((tool) => ({ ...tool, deferLoading: false })); }
