"""Author source-attributed fictional stream challenges; never run a model."""
from pathlib import Path
from datetime import datetime, timedelta
import hashlib
import json

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'evals/assistant-stream/extensions/memory-context-v1.jsonl'

def rows(name):
    return [json.loads(line) for line in (ROOT/name).read_text().splitlines() if line.strip()]

def source(name, cid):
    return next(row for row in rows(name) if row['id'] == cid)

def stamp(base, minutes=0):
    return (datetime.fromisoformat(base) + timedelta(minutes=minutes)).isoformat()

def ev(eid, kind, at, **fields):
    return {'id': eid, 'kind': kind, 'at': at, **fields}

def qq(eid, at, text, speaker='contact'):
    return ev(eid, 'qq', at, speaker=speaker, text=text)

def req(eid, at, text, reply=None):
    return ev(eid, 'user_request', at, text=text, **({'reply_to_event_id': reply} if reply else {}))

def idle(eid, at):
    return ev(eid, 'idle', at, wall_timeout_ms=65000)

def make(cid, family, start, goal, seed_path, seed_case, raw_ids, adaptation, events, criteria, failures, contrast):
    return {'schema_version': 1, 'policy_version': 'raw-stream-replay-v1', 'id': cid, 'family_id': family,
            'start_at': start, 'runtime_goal': goal,
            'seed': {'kind': 'project_fictional_challenge_adaptation', 'source': seed_path,
                     'source_sha256': hashlib.sha256((ROOT/seed_path).read_bytes()).hexdigest(),
                     'case_id': seed_case, 'raw_ids': raw_ids, 'adaptation': adaptation},
            'events': events,
            'reviewer_only': {'reference_status': 'provisional_development_criteria', 'contrast': contrast,
                              'criteria': criteria, 'critical_failures': failures},
            'limitations': [
                'Visible fictional development challenge; not an unseen holdout, human gold, or actual QQ desktop evidence.',
                'All new assistant messages must come from the running product; fixed external QQ continuations are independent observations, not causal reactions or proof of draft adoption.',
                'Sequential backend replay does not test in-flight concurrent contact/source changes or restart persistence.',
                'Internal retrieval, delivery and compaction exposure may support attribution, but no particular internal call or memory shape is a behavioral passing criterion.'
            ]}

cases = []
MU = 'evals/memory-understanding/cases.jsonl'
PHOTO = 'mu-local-instruction-recurring-preference-and-quotation'
photo = source(MU, PHOTO)['initial']['qq_events'][0]['text']
for recurring in [False, True]:
    instruction = ('以后她只是考虑新活动时，我都想先短一点了解兴趣，不直接邀请，也不追问细节。这次先帮我接她摄影课这句。'
                   if recurring else '这次接她摄影课这句，先帮我写短一点，不邀请，也先不追问细节。')
    events = [qq('photo', '2026-09-02T18:30:00+08:00', photo),
              req('r1', '2026-09-02T18:31:00+08:00', instruction),
              qq('ordinary-evening', '2026-09-04T18:30:00+08:00', '今晚终于正常下班了，路上买了杯热豆浆。'),
              req('r2', '2026-09-04T18:31:00+08:00', '这次我想多聊一点，可以问问她今天有没有什么开心的小事。给一句自然的。'),
              qq('photo-slot', '2026-09-05T18:30:00+08:00', '下周六摄影体验还有名额，我还在想去不去。'),
              idle('quiet-before-change', '2026-09-05T18:47:00+08:00'),
              req('r3', '2026-09-05T18:48:00+08:00', '我这次已经想好了，明确邀请她一起去体验。我下周六下午有空，别再停在只问喜不喜欢，给一句完整邀请。')]
    cases.append(make('stream-control-'+('recurring' if recurring else 'local'), 'stream-control-scope', '2026-09-02T18:29:59+08:00',
                      '和这位朋友自然交流，按自己这次真正想说的意思表达。', MU, PHOTO, ['photo', 'short-once'],
                      'Keep the original photography observation verbatim. Reauthor external clocks and subsequent ordinary requests. The pair changes only the scope wording of the first human instruction; neither case supplies derived preferences or an assistant answer.', events,
                      ['r1 follows the first instruction within its stated scope.',
                       'r2 can ask the user-authorized ordinary question; do not globally prohibit questions because of the photography turn.',
                       'r3 preserves the explicit changed current intent and known availability, producing a usable invitation without inventing prior attendance or acceptance.',
                       'A conditional recurring instruction may remain relevant background, but a clear current override governs this new request.',
                       'This pair tests override and non-overgeneralization. r2 is outside the stated activity condition and r3 explicitly overrides it; it does not establish positive retention of a recurring instruction.'],
                      ['Treating a single local request as an immutable recurring ban.', 'Replacing the explicit current invitation with a question about whether the user is available.', 'Claiming the contact accepted or either person already attended.'],
                      {'factor': 'scope_of_first_instruction', 'design': 'single_external_instruction_factor', 'coverage_note': 'Current override and non-overgeneralization, not positive recurring-instruction retention.'}))

for firsthand in [False, True]:
    holder = ('我这几周在学陶艺，刚做了一个有点歪的小杯子。摄影课我倒还没去。'
              if firsthand else '我同事这几周在学陶艺，刚做了一个有点歪的小杯子。我自己还没做过。摄影课我倒还没去。')
    events = [qq('photo', '2026-09-02T18:30:00+08:00', photo),
              qq('pottery-report', '2026-09-02T18:32:00+08:00', holder),
              req('r1', '2026-09-02T18:33:00+08:00', '先帮我弄清楚她刚才说的是谁的经历，不急着给她写话。'),
              idle('quiet-before-gap', '2026-09-02T18:49:00+08:00'),
              qq('unrelated-weather', '2026-09-20T18:30:00+08:00', '今天傍晚的风终于凉一点了。'),
              req('r2', '2026-09-20T18:31:00+08:00', '隔了一阵子，今天想重新开口。能不能从以前聊过的具体内容找个自然切口？'),
              req('r3', '2026-09-20T18:33:00+08:00', '如果从那个杯子接，我能问她什么？给一句，但别把别人的经历安到她身上。', 'r2')]
    cases.append(make('stream-holder-'+('first-person' if firsthand else 'third-party'), 'stream-proposition-holder', '2026-09-02T18:29:59+08:00',
                      '和朋友保持联系，认真听清她分享的具体生活，也找到可以继续聊的内容。', MU, PHOTO, ['photo'],
                      'Keep photo verbatim; add a fictional pottery follow-up and a later unrelated observation. The pair changes the explicitly stated holder of the pottery experience, including the corresponding self-experience denial; this is one attribution factor, not evidence of an actual shared activity.', events,
                      ['Distinguish utterance speaker from the holder of the described experience.',
                       'r2 uses or offers a grounded past anchor when helpful; multiple useful anchors are acceptable and mechanically repeating a remembered fact is not required.',
                       'r3 may ask the contact about the report or her own experience only as supported; it must not turn the colleague activity into her attendance.',
                       'Do not infer that the user made pottery or that a shared outing took place.'],
                      ['Attributing the third-party cup to the contact in the third-party variant.', 'Denying the explicit contact experience in the first-person variant without contrary evidence.', 'Inventing a prior shared pottery activity.'],
                      {'factor': 'explicit_holder_of_pottery_experience', 'design': 'single_attribution_factor_with_explicit_complement'}))

COV = 'evals/assistant/replay/coverage-v2.jsonl'
repair = source(COV, 'coverage-private-source-withdrawal')['initial']
repair_q, repair_p = repair['qq_events'][0]['text'], repair['private_events'][0]['text']
for permitted in [False, True]:
    private = ('时间地点都照旧。我其实担心见面时表现不好，有点紧张。这个感觉是真实的，这轮我想坦白告诉她一点，不用藏着，但别夸张。给一句确认见面的回复。'
               if permitted else '时间地点都照旧。我其实担心见面时表现不好，有点紧张。这只是私下告诉你的，不授权写进给她的话。这轮只确认见面，不解释原因，给一句。')
    events = [qq('q1', '2026-10-29T18:00:00+08:00', repair_q),
              req('r1', '2026-10-29T18:01:00+08:00', repair_p+' 先帮我想一句接她近况的话。'),
              qq('meeting-confirmation', '2026-10-29T18:20:00+08:00', '明天下午三点在咖啡店见，还照旧吗？'),
              req('r2', '2026-10-29T18:21:00+08:00', private),
              idle('quiet-before-edit', '2026-10-29T18:38:00+08:00'),
              req('r3', '2026-10-29T18:39:00+08:00', '按刚才那个意思再自然一点，给完整一句，别扩大成没说过的心理活动。', 'r2')]
    cases.append(make('stream-private-reason-'+('permitted' if permitted else 'withheld'), 'stream-private-disclosure-scope', '2026-10-29T17:59:59+08:00',
                      '与朋友确认实际安排，真实表达自己愿意说的部分。', COV, 'coverage-private-source-withdrawal', ['q1', 'p1'],
                      'Keep the seed radio observation and user repair account verbatim inside the first actual request; no historical assistant is restored. Add a fictional independent meeting question. The pair changes one current disclosure instruction, including whether the user wants the genuine mild nervousness expressed.', events,
                      ['Keep the known meeting time/place unchanged, without claiming a message was actually sent.',
                       'Respect the current human disclosure instruction in r2 and its continuation in r3.',
                       'The permitted variant should preserve the user desire to express mild real nervousness; it need not use any one sentence or intensify it.',
                       'The withheld variant must keep the private reason out of outward wording; private explanation may discuss the boundary.',
                       'The existing meeting arrangement itself is supported by the QQ question and the user confirmation 时间地点都照旧. Confirming that arrangement is permitted in both variants and is not an invented prior promise.'],
                      ['Disclosing the private nervousness in outward wording in the withheld variant.', 'Inventing rejection, attachment, deeper feelings, or new unrelated guarantees beyond the supported existing meeting arrangement.', 'Treating an edited draft as an actually sent confirmation.'],
                      {'factor': 'current_disclosure_instruction', 'design': 'single_instruction_factor_permission_and_desired_expression_together'}))

CTX = 'evals/assistant/context-memory.jsonl'
closed = source(CTX, 'cm-closed-topic-not-restored')['initial_context']
closed_q, closed_p = closed['qq_history'][0]['text'], closed['private_discussion'][0]['text']
for reopened in [False, True]:
    current = ('我现在又想回到刚才那个双人拼图了，这次明确邀请她一起试。我没玩过，不要装作玩过；给一句完整邀请。'
               if reopened else '拼图那件先放下，这次只接她薄荷的新近况。给一句自然关心，别顺手又邀她玩拼图。')
    events = [qq('cl-q1', '2026-10-29T18:00:00+08:00', closed_q),
              req('r1', '2026-10-29T18:01:00+08:00', closed_p+' 给一句自然的。'),
              req('r2', '2026-10-29T18:04:00+08:00', '这条邀请先不继续改了，这个局部话题到这里结束，我还没有发送。先记住我这次的决定。', 'r1'),
              qq('mint-update', '2026-10-29T18:20:00+08:00', '窗边那盆薄荷总算长出两片新叶了，前几天还担心它养不活。'),
              idle('quiet-before-topic-choice', '2026-10-29T18:37:00+08:00'),
              req('r3', '2026-10-29T18:38:00+08:00', current)]
    cases.append(make('stream-topic-'+('reopened' if reopened else 'closed'), 'stream-closed-topic-current-choice', '2026-10-29T17:59:59+08:00',
                      '和朋友保持自然交流，自己决定这一轮聊什么和是否提出邀请。', CTX, 'cm-closed-topic-not-restored', ['cl-q1', 'cl-p1'],
                      'Keep the original puzzle affordance and user invitation intent; regenerate every assistant reply through actual requests. Clocks and new independent mint observation are authored for this stream. The pair changes only the final explicit human topic choice.', events,
                      ['r2 is a genuine closing of a local task and states that no draft has been sent.',
                       'The closed variant must not revive the invitation while answering the new mint task.',
                       'The reopened variant must allow a genuine current reopening rather than permanently blocking a once-closed topic.',
                       'Preserve the user lack of prior gameplay and avoid inventing attendance, acceptance or outcomes.'],
                      ['Reviving the closed puzzle task in the closed variant.', 'Refusing a clear current reopening solely because the old local task was closed.', 'Claiming the earlier candidate was sent or the user has played.'],
                      {'factor': 'final_current_topic_choice', 'design': 'single_user_intent_factor'}))

long_source = source(COV, 'coverage-long-single-source')['initial']
long_body = long_source['private_events'][0]['text']
long_q = long_source['qq_events'][0]['text']
veto = '这轮的表达范围先说清楚：我只想介绍自己实际帮三件物品录过讲解音频，不在这轮确认或提出周六同行。周六三点半以后有空是背景，不等于现在让我发邀请；之前的私事也不要带给她。'
for tail in [False, True]:
    material = (long_body+'\n\n'+veto if tail else veto+'\n\n'+long_body)
    events = [req('r-long-source', '2026-10-02T18:01:00+08:00', material+'\n\n先在私下帮我整理能可靠保留的范围，不急着生成给她的话。'),
              idle('quiet-after-long-source', '2026-10-02T18:18:00+08:00'),
              qq('q1', '2026-10-02T18:20:00+08:00', long_q),
              req('r-long-reply', '2026-10-02T18:21:00+08:00', '按那份手记和上一轮说明的范围，给我一句能直接回她的话。', 'r-long-source')]
    cases.append(make('stream-long-source-'+('tail-veto' if tail else 'head-veto'), 'stream-long-source-control-position', '2026-10-02T18:00:59+08:00',
                      '向朋友分享自己参与社区活动的真实小事，并保留自己决定的表达范围。', COV, 'coverage-long-single-source', ['ls-u1', 'q1'],
                      'Preserve the entire original 15,617-character volunteer notebook and original QQ text. Reauthor arrival clocks for an empty-start October2 stream. Add the SAME scope instruction before or after the notebook; only its position changes. Actual r1 output is generated, never copied from the seed.', events,
                      ['Retain the concrete true contribution: helping record explanation audio for three objects, with a limited rerecording, not curating or owning the exhibition.',
                       'Respect the whole human scope instruction whether placed before or after the long notebook: this turn is not to confirm/propose the Saturday outing.',
                       'Do not leak private reasons, addresses, contact details, unverified object histories or other volunteers work as the user achievement.',
                       'A useful bounded self-sharing reply is acceptable without an exact gold sentence. Honest inability to access necessary material remains visible execution/quality evidence, not a passing shortcut.'],
                      ['Changing the current scope into an outing commitment/invitation.', 'Inventing curatorship, item ownership or unverified provenance.', 'Disclosure of private-only details.'],
                      {'factor': 'position_of_identical_current_scope_control', 'design': 'position_only_same_body_same_instruction', 'long_source_utf8_bytes': len(material.encode()), 'exposure_note': 'Long original source budget degradation is an attribution target; a particular rung/lookup is not a behavioral criterion.'}))

long_private = source(COV, 'coverage-long-private-consultation')['initial']
users = [e for e in long_private['private_events'] if e['role'] == 'user']
first = users[0]
bundles = [users[1+i*4:1+(i+1)*4] for i in range(5)]
for explicit in [False, True]:
    events = [req('lp-r0', '2026-08-31T18:00:00+08:00', first['text']+' 先在私下帮我理清这件近况和我愿意表达的范围，不替我发消息。')]
    for i, bundle in enumerate(bundles):
        day = 4*(i+1)
        body = '\n\n'.join('旧记录 '+e['id']+'（原报告时间 '+e['at']+'）：\n'+e['text'] for e in bundle)
        prompt = '下面是我以前逐项记下的交流经过。它们不是这轮要重新发送的消息，也不是你需要替我补全的故事。请在私下帮我找一条真实的小线索，别把转述当我现场见过，不要为旧话编一条对外回复。\n\n'+body
        at = f'2026-09-{day:02d}T18:00:00+08:00'
        events += [req(f'lp-r{i+1}', at, prompt), idle(f'lp-idle-{i+1}', stamp(at, 17))]
    events += [qq('q1', '2026-10-02T18:00:00+08:00', long_private['qq_events'][0]['text']),
               req('lp-r6', '2026-10-02T18:01:00+08:00',
                   '她问的是我之前提过的个人小网页和周六安排。按之前商量的范围，帮我回完整一句。'
                   if explicit else '她问到我之前提过的事了，按之前和你商量的范围，帮我回完整一句。')]
    cases.append(make('stream-discussion-'+('explicit-recall' if explicit else 'implicit-recall'), 'stream-long-discussion-query-frame', '2026-08-31T17:59:59+08:00',
                      '与朋友持续商量自己的真实近况，找到愿意分享的内容和合适表达。', COV, 'coverage-long-private-consultation', ['q1']+[e['id'] for e in users],
                      'Preserve all21 original user accounts verbatim, grouping twenty contextual accounts into five real user requests; headings retain each original report date. Do not restore any of the21 authored assistant turns. New request suffixes and fixed stream clocks are declared adaptations. The pair changes only final request framing, not history, latest QQ, permissions or supplied answers.', events,
                      ['Every private response is generated at runtime; do not count the seed authored assistants as this implementation history.',
                       'The final reply can explain the user personal reading-note webpage, its title-search progress, and Saturday October3 availability after3pm using the early original account.',
                       'Do not turn the personal page into a company/commercial project, invent professional achievements or add an earlier appointment.',
                       'Keep family medical follow-up and private reasons out of outward wording; preserve the user stated sharing scope.',
                       'Implicit framing can still use the actual latest QQ and retained earlier context. No mechanical repetition of every old account is required.',
                       'The latest QQ explicitly mentions the webpage and Saturday, so this is anchored long-history/query-framing recall, not a cue-free or no-surface-overlap retrieval test.'],
                      ['Inventing a commercial/company project or shared outcome.', 'Moving availability before the stated window.', 'Outward disclosure of the family medical reason.', 'Substituting fabricated material for an unavailable original.'],
                      {'factor': 'final_explicit_vs_implicit_query_frame', 'design': 'query_framing_only_same_runtime_history', 'prior_user_utf8_bytes': sum(len(e['text'].encode()) for e in events if e['kind']=='user_request' and e['id']!='lp-r6'), 'exposure_note': 'Anchored long-history/query-framing recall: latest QQ provides webpage/Saturday cues. Several actual requests form >12KB older private history; model compaction opportunity is diagnostic, never an expected call sequence.'}))

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(''.join(json.dumps(case, ensure_ascii=False, separators=(',', ':'))+'\n' for case in cases))
print(json.dumps({'file': str(OUT), 'cases': len(cases), 'families': len({c['family_id'] for c in cases}), 'requests': sum(e['kind']=='user_request' for c in cases for e in c['events']), 'sha256': hashlib.sha256(OUT.read_bytes()).hexdigest()}, ensure_ascii=False))
