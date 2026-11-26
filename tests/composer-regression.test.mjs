import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const source = html + "\n" + css;
test("the composer has exactly one real Send button", () => {
  assert.equal((html.match(/id="sendBtn"/g) || []).length, 1);
  assert.match(html, /id="sendBtn"[^>]*aria-label="Send message"/);
  assert.match(html, /getElementById\('sendBtn'\)\.addEventListener\('click', handleSend\)/);
});
test("speech recognition and obsolete microphone controls are absent", () => {
  assert.doesNotMatch(source, /SpeechRecognition|webkitSpeechRecognition|voiceModeBtn|mobileMicBtn|voice-mode-btn|mobile-mic-btn/i);
});
test("no mobile rule or script can hide the Send button", () => {
  assert.doesNotMatch(source, /(?:#sendBtn|\.send-btn)[^{}]*\{[^{}]*display\s*:\s*none/i);
  assert.doesNotMatch(html, /setProperty\(['"]display['"],\s*['"]none['"],\s*['"]important['"]\)/);
  assert.match(css, /#sendBtn\.send-btn\{[^}]*display:inline-flex!important/);
});
test("desktop Enter sends, Shift+Enter inserts a newline, and mobile Enter stays native", () => {
  assert.match(html, /enterkeyhint="enter"/);
  assert.match(html, /const isDesktopPlatform = [^;]+/);
  assert.match(html, /if \(!isDesktopPlatform \|\| !isEnter \|\| e\.isComposing\) return;[\s\S]{0,100}if \(e\.shiftKey\) return;[\s\S]{0,100}e\.preventDefault\(\);[\s\S]{0,50}handleSend\(\);/);
  assert.match(html, /id="sendBtn"[^>]*aria-label="Send message"/);
});


test("large-task failures use ULTRON's Malayalam line while actionable errors remain useful", () => {
  assert.ok(html.includes("const accountOrLimitFailure = /\\b401\\b|\\b403\\b|\\b429\\b"));
  assert.ok(html.includes("const actionableInputFailure = /\\b413\\b"));
  assert.ok(html.includes("const isSubstantialTask = prompt.length >= 350"));
  assert.match(html, /else if \(isSubstantialTask\) \{[\s\S]{0,200}Ith ennekond koottiyal koodilla mone, nee ChatGPT aduth choyich nokk/);
  assert.ok(html.includes("conversation too long"));
  assert.ok(html.includes("Send your message again to retry, or open Settings to check the Worker URL"));
  assert.match(html, /e\.timeout = true/);
});


test("chat history and workspace metadata are isolated by Google account", () => {
  assert.match(html, /function getAccountStorageKey\(\)[\s\S]*?encodeURIComponent\(googleAccountEmail\.trim\(\)\.toLowerCase\(\)\)/);
  assert.match(html, /function getThreadDatabaseName\(\)[\s\S]*?openclaude-thread-store:/);
  assert.match(html, /indexedDB\.open\(activeThreadDbName \|\| THREAD_DB_NAME, THREAD_DB_VERSION\)/);
  assert.match(html, /localStorage\.getItem\(activeStorageKey \|\| STORAGE_KEY\)/);
  assert.match(html, /void activateAccountWorkspace\(\)/);
  assert.match(html, /if \(!activeStorageKey\) return/);
  assert.match(html, /old unscoped workspace is deliberately not auto-imported/);
});

test("signing out clears the visible workspace and closes its account database", () => {
  assert.match(html, /activeAccountEmail = '';[\s\S]*?threadDatabase\.close\(\)[\s\S]*?state = structuredClone\(defaultState\)/);
});


test("non-owner accounts never turn ordinary skill-enabled chat into a connected-tool request", () => {
  assert.ok(html.includes("let connectedAppsAvailable = false"));
  assert.ok(html.includes("const toolSession = connectedAppsAvailable && skillTools.includes('github.read')"));
  assert.ok(html.includes("'/account/access'"));
  assert.ok(html.includes('id="appConnectorsSection" style="display:none'));
});

test("connected-app controls are shown only when the Worker confirms owner access", () => {
  assert.ok(html.includes("connectedAppsAvailable = response.ok && data.connectedAppsAvailable === true"));
  assert.ok(html.includes("section.style.display = connectedAppsAvailable ? '' : 'none'"));
  assert.ok(html.includes("if (section) section.style.display = 'none'"));
});
