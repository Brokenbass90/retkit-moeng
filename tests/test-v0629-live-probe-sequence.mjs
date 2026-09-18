import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../src/retkit-moengage-v0.5.user.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../src/core/retkit-moengage-core.user.js', import.meta.url), 'utf8');

assert.match(bridge, /@version\s+0\.6\.31/, 'bridge userscript should be v0.6.31');
assert.match(bridge, /buttons,\s*clientX,\s*clientY,\s*view: root/s, 'React nativeEvent should carry live mouse metadata');
assert.match(bridge, /function activateReactClickable/, 'portal actions should have a React click helper');
assert.match(bridge, /All\\s\+Locales\\s\+selected/, 'All selection should verify the native MoEngage control label');

assert.match(core, /looksLikeLocaleSwitch/, 'core should distinguish locale switches from late native reverts');
assert.match(core, /nextLang !== currentLang/, 'different HTML language should be treated as a locale switch');
assert.match(core, /!looksLikeLocaleSwitch && shouldTreatNativeMismatchAsLateRevert/, 'locale switches must not create false late_native_revert incidents');

console.log('v0.6.31 live probe sequence regression checks passed');
