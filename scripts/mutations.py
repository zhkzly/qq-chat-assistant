#!/usr/bin/env python3
"""Reproducible rejection checks against the assistant's consequential boundaries."""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
CASES = [
 ('native-send-rejection', 'plugin/native-driver.cjs', 'node tests/native.test.cjs', 'if (!READ_COMMANDS.includes(name))', 'if (false)'),
 ('native-account-binding', 'plugin/native-driver.cjs', 'node tests/native.test.cjs', 'this.account.uid !== scope.accountUid', 'false'),
 ('native-peer-binding', 'plugin/native-driver.cjs', 'node tests/native.test.cjs', 'this.selected.uin !== scope.peerUin', 'false'),
 ('native-history-errors', 'plugin/native-driver.cjs', 'node tests/native.test.cjs', "if (result.result !== undefined && result.result !== 0)", 'if (false)'),
 ('native-bind-race', 'plugin/native-driver.cjs', 'node tests/native.test.cjs', ' || binding !== this.binding', ''),
 ('confirmed-send-only', 'src/messages.cjs', 'node tests/core.test.cjs', 'raw.sendStatus !== 2', 'raw.sendStatus !== 0'),
 ('opaque-message-id', 'src/messages.cjs', 'node tests/core.test.cjs', 'messageId: raw.msgId', 'messageId: String(Number(raw.msgId))'),
 ('message-peer-filter', 'src/messages.cjs', 'node tests/core.test.cjs', 'raw.peerUid !== scope.peerUid', 'false'),
 ('store-account-filter', 'src/store.cjs', 'node tests/core.test.cjs', "scope.accountUid, scope.peerUid).map(row", "'u_second', scope.peerUid).map(row"),
 ('draft-provenance', 'src/store.cjs', 'node tests/core.test.cjs', "message.kind !== 'actual'", 'false'),
 ('model-format', 'src/model.cjs', 'node tests/core.test.cjs', 'value.suggestions.length !== 3', 'false'),
 ('model-quoted-directions', 'src/model.cjs', 'node tests/core.test.cjs', "message.direction === 'outgoing' ? '我' : '对方'", "'对方'"),
 ('generation-stale-check', 'src/controller.cjs', 'node tests/controller.test.cjs', 'if (epoch !== this.epoch || revision !== this.revision || instruction !== this.instruction || abort.signal.aborted ||\n          !sameScope(scope, this.scope)) return;', 'if (false) return;'),
 ('generation-message-revision', 'src/controller.cjs', 'node tests/controller.test.cjs', 'revision !== this.revision', 'false'),
 ('cached-history-gap', 'src/controller.cjs', 'node tests/controller.test.cjs', 'const messages = result.messages.map(m => normalize(m, scope)).filter(Boolean).sort(compare);', 'const messages = this.store.messages(scope);'),
 ('api-token', 'src/server.cjs', 'node tests/server.test.cjs', 'auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)', 'false'),
 ('api-origin', 'src/server.cjs', 'node tests/server.test.cjs', 'request.headers.origin && request.headers.origin !== origin', 'false'),
 ('native-read-route', 'plugin/ipc-transport.cjs', 'node tests/transport.test.cjs', 'if (!READ_ROUTES.includes(route))', 'if (false)'),
 ('native-page-count', 'plugin/ipc-transport.cjs', 'node tests/transport.test.cjs', 'cnt: count, queryOrder: !queryOrder', 'count, queryOrder: !queryOrder'),
 ('native-page-direction', 'plugin/ipc-transport.cjs', 'node tests/transport.test.cjs', 'queryOrder: !queryOrder', 'queryOrder'),
 ('native-active-msg', 'plugin/ipc-transport.cjs', 'node tests/transport.test.cjs', "if (name === 'onRecvActiveMsg')", 'if (false)'),
 ('native-window-owner', 'plugin/ipc-transport.cjs', 'node tests/transport.test.cjs', 'this.windowAccounts.get(wc)!==this.account.uid', 'false'),
 ('native-worker-command', 'plugin/main.cjs', 'node tests/plugin.test.cjs', 'await driver.command(message.command, message.args)', '{}'),
 ('preload-capabilities', 'plugin/preload.cjs', 'node tests/plugin.test.cjs', 'open: uin =>', 'send: uin =>'),
 ('closed-window-generation', 'src/controller.cjs', 'node tests/controller.test.cjs', 'if(!this.visible)return;', 'if(false)return;'),

 ('model-data-consent', 'src/controller.cjs', 'node tests/controller.test.cjs', 'if(!this.hasModelConsent()) { this.error=', 'if(false) { this.error='),

 ('consent-account-view','src/server.cjs','node tests/server.test.cjs','args.accountUid!==controller.scope.accountUid','false'),
 ('consent-peer-view','src/server.cjs','node tests/server.test.cjs','args.peerUin!==controller.scope.peerUin','false'),
 ('consent-destination-view','src/server.cjs','node tests/server.test.cjs','args.baseUrl!==controller.settings.baseUrl','false'),
 ('consent-model-view','src/server.cjs','node tests/server.test.cjs','args.model!==controller.settings.model','false'),

 ('gui-focus-snapshot','plugin/main.cjs','node tests/gui-binding.test.cjs','const focused = BrowserWindow.getFocusedWindow();','const focused = null;'),
 ('gui-lookup-order','plugin/main.cjs','node tests/gui-binding.test.cjs','peerVersions.get(receiver.id)===revision','true'),
 ('gui-session-epoch','plugin/main.cjs','node tests/gui-binding.test.cjs','if(epoch!==guiEpoch || ownerUid!==driver.account?.uid) return;','if(false) return;'),
 ('gui-cache-account','plugin/main.cjs','node tests/gui-binding.test.cjs','if(cachedPeer?.accountUid===driver.account?.uid)','if(cachedPeer)'),
 ('native-request-owner','plugin/ipc-transport.cjs','node tests/transport.test.cjs','!self.account || self.windowAccounts.get(event.sender)===self.account.uid','true'),
 ('native-read-context-owner','plugin/ipc-transport.cjs','node tests/transport.test.cjs','this.account && this.windowAccounts.get(this.context.event.sender)!==this.account.uid','false'),

 ('initial-read-error','src/controller.cjs','node tests/history-state.test.cjs',"status:'read_error',error:error.message","status:'loading',error:error.message"),
 ('empty-read-state','src/controller.cjs','node tests/history-state.test.cjs',"cached.length ? 'cached_only' : 'empty'","cached.length ? 'cached_only' : 'loading'"),
 ('context-secret-projection','src/model.cjs','node tests/context-safety.test.cjs','const text = redact(message.text).slice(0, 1800);','const text = message.text.slice(0, 1800);'),
 ('reply-placeholder-cleanup','src/model.cjs','node tests/context-safety.test.cjs',"text: s.text.replace(/\\[(?:表情|图片|语音|视频|文件|非文本消息)\\]/g,'').trim()","text:s.text.trim()"),
 ('media-root-binding','src/media.cjs','node tests/media.test.cjs','if(!allowed.some(root=>real===root||real.startsWith(root+path.sep)))continue;','if(false)continue;'),
 ('media-path-disclosure','src/media.cjs','node tests/media.test.cjs','message.media.map(({localPaths,...data})=>data)','message.media.map(data=>data)'),
 ('image-consent-gate','src/controller.cjs','node tests/vision.test.cjs','!this.settings.realChatConsent?.allowImages','false'),
 ('draft-contact-binding','plugin/draft.cjs','node tests/draft.test.cjs','matches:state.peer?.peerUid===scope.peerUid','matches:true'),
 ('production-vue-contact','plugin/contact.cjs','node tests/contact.test.cjs','for(const component of element.__VUE__||[])','for(const component of [])'),
 ('ambiguous-contact','plugin/contact.cjs','node tests/contact.test.cjs','peers.size===1&&','peers.size>=1&&'),
 ('draft-native-window-owner','plugin/draft.cjs','node tests/draft.test.cjs','if(owner!==scope.accountUid){','if(false){'),
 ('draft-switch-before-insert','plugin/draft.cjs','node tests/draft.test.cjs','state.peer?.peerUid!==${JSON.stringify(scope.peerUid)}','false'),
 ('context-preview-keeps-advice','src/controller.cjs','node tests/controller.test.cjs'," && instruction.slice(0,2000)!==this.instruction",''),
 ('cached-current-peer','plugin/contact.cjs','node tests/contact.test.cjs','if(cached.peer)visit(cached.peer);','if(false)visit(cached.peer);'),
 ('qq-private-type-shape','plugin/contact.cjs','node tests/contact.test.cjs','value.chatType??value.type','value.chatType'),
 ('native-rich-draft-protection','plugin/contact.cjs','node tests/draft.test.cjs','nativeEditorEmpty===false','false'),
 ('ui-fill-async-binding','ui/app.js','node scripts/browser-check.cjs',
  " const requestedScope=scopeKey,args={accountUid:state.scope.accountUid,peerUin:state.scope.peerUin,text:$('draft').value};\n const desktop=await(await api('/api/desktop')).json();\n if(requestedScope!==scopeKey)throw new Error('会话已切换，已取消这次回填');",
  " const requestedScope=scopeKey;\n const desktop=await(await api('/api/desktop')).json();\n const args={accountUid:state.scope.accountUid,peerUin:state.scope.peerUin,text:$('draft').value};"),
 ('draft-owner-binding','plugin/draft.cjs','node tests/draft.test.cjs','account.uid!==scope.accountUid','false'),
 ('existing-draft-preservation','plugin/draft.cjs','node tests/draft.test.cjs','if(state.draftNonempty && !${JSON.stringify(replace)})','if(false)'),

]

if len(sys.argv) == 3 and sys.argv[1] == '--inject':
    case = next(c for c in CASES if c[0] == sys.argv[2])
    target = ROOT / case[1]
    original = target.read_text()
    if original.count(case[3]) != 1:
        raise SystemExit('Mutation anchor must occur exactly once: ' + case[0])
    target.write_text(original.replace(case[3], case[4], 1))
    raise SystemExit(0)

receipts = []
for name, target, tests, old, new in CASES:
    cmd = [sys.executable, '/home/zhkzly/ai-workbench/tools/mutation_license.py', '--tests', tests,
           '--target', target, '--mutate', f'python3 scripts/mutations.py --inject {name}']
    result = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
    print(name + ': ' + ('PASS' if result.returncode == 0 else 'FAIL'))
    receipts.append({'case': name, 'target': target, 'exitCode': result.returncode, 'result': result.stdout.strip()})
    if result.returncode:
        print(result.stdout[-1500:]); print(result.stderr[-1500:])
        break
(ROOT / 'research/mutation-evidence.json').write_text(json.dumps(receipts, ensure_ascii=False, indent=2) + '\n')
raise SystemExit(0 if len(receipts) == len(CASES) and all(r['exitCode'] == 0 for r in receipts) else 1)
