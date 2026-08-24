/*
 * 依存ゼロの最小 i18n。en をキーの単一ソースとし、ja は全キー必須(型で担保)。
 * 言語は localStorage(csb-lang)→ navigator.language の順で決まり、設定モーダルで切替可能。
 * テスト(Node 環境)からも import されるため、ブラウザ API へのアクセスは必ずガードする。
 */

import type {
  Lang,
  LintCode,
  MemoryType,
  MemoryVerdict,
  RelationType,
} from '../../src/shared/types';

export type { Lang };

const en = {
  'app.subtitle': 'skills · commands · agents · hooks · memory — installed on this machine',
  'app.count': '{shown} / {total} items',
  'app.searchPlaceholder': 'Search by name or description…',
  'app.settings': 'Settings',
  'app.loadFailed': 'Failed to load: {msg}',

  'sort.title': 'Sort order',
  'sort.name': 'Name',
  'sort.uses': 'Most used',
  'sort.recent': 'Recently used',
  'sort.updated': 'Recently updated',
  'sort.tokens': 'Token cost',
  'sort.memIndex': 'Index tokens (high → low)',
  'sort.memBody': 'Body tokens (high → low)',
  'sort.memStale': 'Oldest update first',
  'kind.all': 'All',
  'filter.used': 'Recent use',
  'filter.usedTitle':
    'Show only items with recorded use in the transcript retention window (default 30 days)',
  'filter.unused': 'No recent use',
  'filter.unusedTitle':
    'Show only items with no recorded use in the transcript retention window (default 30 days)',

  'ai.button': 'AI summaries',
  'ai.progress': 'Summarizing {done}/{total}',
  'ai.stale': 'AI summaries ({n} pending)',
  'ai.done': 'AI summaries ✓',
  'ai.buttonTitle':
    'Summarize each SKILL.md via claude CLI (model configurable in Settings). Only changed ones are regenerated',
  'ai.confirmForce': 'All summaries are up to date. Force-regenerate all {n} items? (claude CLI)',
  'ai.confirmRun': 'Summarize {n} SKILL.md files via claude CLI?',
  'ai.finishedErrors': 'Summarization finished ({n} errors):',
  'ai.startFailed': 'Failed to start: {msg}',

  'view.source': 'By source',
  'view.group': 'By purpose',
  'view.memory': 'Memory',
  'view.flat': 'Flat',
  'view.title': 'View: where items live / when to use them / auto memory / one flat list',
  'filter.kindPrefix': 'Kind: {v}',
  'filter.usePrefix': 'Use: {v}',
  'filter.refPrefix': 'Reads: {v}',
  'filter.refRead': 'Read',
  'filter.refUnread': 'Not read',
  'filter.refTitle':
    'Whether the body was Read within the transcript retention window (default 30 days). Projects without transcripts are excluded from both',
  'ai.menu': '✦ AI',
  'ai.menuTitle': 'AI actions: summaries and purpose grouping (claude CLI)',
  'group.other': 'Other',
  'group.manual': 'manual',
  'group.manualTitle':
    'Fixed via "category" in the frontmatter (takes precedence over AI grouping)',
  'group.generate': '✦ Classify by purpose (AI)',
  'group.generating': 'Classifying…',
  'group.generateTitle':
    'Group everything installed by when to use it, via one claude CLI call for the whole environment',
  'group.empty':
    'No purpose groups yet. One claude CLI call classifies everything installed by when to use it.',
  'group.stale': 'Items changed since the last classification',
  'group.staleAction': 'reclassify from the ✦ AI menu',
  'group.menuGenerate': 'Generate purpose groups',
  'group.menuRegen': 'Reclassify purpose groups',
  'alert.groupFailed': 'Classification failed: {msg}',

  'list.empty': 'No skills match the filters',
  'card.uses': 'Used {n}× · last {date}',
  'card.noUses': 'No recorded use',
  'card.updated': 'Updated {date}',
  'card.tokens': '~{n} tok',
  'badge.unused': 'no recent use',
  'badge.unusedTitle':
    'No recorded use within the transcript retention window (default 30 days). Older use is not visible.',
  'badge.warnTitle': 'Description issues:',
  'sec.tokens': '≈{n} tok/session',
  'app.tokens': '≈{n} tokens/session',
  'app.tokensTitle':
    'Approx. tokens injected into every session in the current project (name + description of built-ins, plugins, user scope and the current project)',

  'memory.searchPlaceholder': 'Search memory…',
  'memory.secLabel': 'MEMORY — {name}',
  /* basename だけの見出しでは同名プロジェクト(teamA/ai-workspace と teamB/ai-workspace)を区別できないため、
   * フルパスを副題で必ず添える。プロジェクト不明は逆引き先が無いので memory dir の実パスを、
   * プロジェクトのパスと誤読されないよう別ラベル(secMemDir)で出す */
  'memory.secPath': 'Path: {path}',
  'memory.secMemDir': 'memory dir: {path}',
  'memory.orphan': 'unknown project',
  'memory.orphanTitle':
    'No matching project — possible causes include an unmounted external volume, leftover files from a deleted worktree, or the project having been unregistered (the encoded directory name may not decode back into the original path)',
  'memory.type.user': 'About you',
  'memory.type.feedback': 'Guidance',
  'memory.type.project': 'Project',
  'memory.type.reference': 'Reference',
  'memory.today': 'updated today',
  'memory.stale': '{n}d without update',
  'memory.secTokensTitle':
    'Approx. tokens of this project’s MEMORY.md index lines. The index lists every memory and is injected into every session, whether or not the bodies are read.',
  'memory.idx': 'index',
  'memory.body': 'body',
  'memory.indexTokTitle':
    'Always-on cost: this memory’s line in MEMORY.md, injected into every session (0 = not listed in the index)',
  'memory.bodyTokTitle': 'Pay-per-use cost: the whole body, charged only when it is Read',
  'memory.readsTitle':
    'Times this memory was Read within the transcript retention window (default 30 days). 0 does not mean it has never been read.',
  'memory.writesTitle':
    'Times this memory was created or updated (Write / Edit) within the transcript retention window',
  'memory.unread': 'no recent reads',
  'memory.unreadTitle':
    'The body was not Read within the transcript retention window (default 30 days). Not an anomaly: index-line-only memories work without being read.',
  'memory.linkBrokenTitle': 'No memory with this name in this project',
  'memory.brokenBadgeTitle': '[[link]] targets with no matching memory in this project: {n}',

  /* コストバー: 常時(索引)と従量(本文)を分けて見せる。減らせる変数は件数だけ */
  'memory.cost.indexK': 'Index — every session',
  'memory.cost.indexNote':
    'Index lines for {n} memories are\ninjected unconditionally every session',
  'memory.cost.bodyK': 'Bodies — only when read',
  'memory.cost.bodyNote': 'Costs nothing unless read.\n{k} / {n} read within the retention window',
  'memory.cost.bodyNoteNA': 'Costs nothing unless read.\nReads cannot be measured (no transcripts)',
  'memory.cost.perK': 'Per memory',
  'memory.cost.perNote':
    'Only the count can be reduced.\nShortening a body does not change the index',
  'memory.cost.unit': 'tok',
  'memory.cmp.memory': 'memory index',
  'memory.cmp.plugin': 'plugin',
  'memory.cmp.user': 'user skill',
  'memory.cmpTitle':
    'Per-session injection compared with other always-on sources in this environment (plugin / user skills: name + description totals)',

  /* カード・詳細の参照実績。Read 0 は異常ではないので言い切らない */
  'memory.card.reads': 'Body read {n}× · last {date}',
  'memory.card.noReads': 'No recorded body reads',
  'memory.card.noReadsFeedback': 'No recorded body reads — works from its index line alone',
  'memory.card.na': 'Reads cannot be measured',

  'memory.back': '← List',
  'memory.tab.body': 'Body',
  'memory.warnline': 'Broken links ({n}): {names}',
  'memory.sec.cost': 'Context cost',
  'memory.sec.reads': 'Read activity',
  'memory.sec.links': 'Links',
  'memory.sec.frontmatter': 'frontmatter',
  'memory.cbox.indexK': 'Index line — every session',
  'memory.cbox.indexNote':
    'Injected unconditionally as one line of MEMORY.md whenever you work in this project.',
  'memory.cbox.bodyRead': 'Charged only when read. Read {n}× within the retention window.',
  'memory.cbox.bodyUnread':
    'Charged only when read. No reads recorded within the retention window.',
  'memory.cbox.bodyNA': 'Charged only when read. Reads cannot be measured (no transcripts).',
  'memory.f.reads': 'Body reads',
  'memory.f.writes': 'Created / updated',
  'memory.f.origin': 'Origin session',
  'memory.f.times': '{n}×',
  'memory.f.last': ' — last {date}',
  'memory.f.none': 'None',
  'memory.f.noneNote': ' — within the transcript retention window',
  'memory.f.na': 'Not measurable',
  'memory.linkDead': '{name} (broken)',

  /* 棚卸し診断: AI は行き先の仮説と指示文までを出し、実行は貼り先の Claude Code に委ねる */
  'memory.triage.section': '✦ Triage',
  'memory.triage.sectionTitle':
    'Ask the model where each memory of this project should go, and get an instruction to paste into Claude Code',
  'memory.triage.heading': 'Memory triage',
  'memory.triage.back': '← Memory list',
  'memory.triage.title': 'Triage — {project}',
  'memory.triage.sub':
    '✦ This tool does not act. For each proposal it prepares an instruction to paste into Claude Code',
  'memory.triage.run': 'Run triage',
  'memory.triage.running': 'Triaging…',
  'memory.triage.rerun': 'Re-run triage',
  'memory.triage.runTitle':
    'One claude CLI call reads every memory body and proposes a destination (cached per memory; only changed ones are re-asked)',
  'memory.triage.rerunTitle':
    'Re-ask for every memory, ignoring the cache (claude CLI is called once, or a few times for very large projects)',
  'memory.triage.summary': '{n} triaged — {p} proposals, {k} keep as is',
  'memory.triage.summaryWithErrors':
    '{n} triaged — {p} proposals, {k} keep as is, {e} with invalid output',
  'memory.triage.summaryPending': '{u} of {n} not triaged yet',
  'memory.triage.ctaTitle': 'Not triaged yet',
  'memory.triage.ctaBody':
    'Nothing has been asked of the AI yet — the rows below are facts only. Run triage to read all {n} bodies with the claude CLI (one call; split into a few for very large projects) and get a destination + a paste-ready instruction for each (usually 1–2 minutes).',
  'memory.triage.ctaPartial':
    '{u} of {n} memories changed since the last triage. Run triage to re-ask only those with the claude CLI.',
  'memory.triage.busyTitle': 'Triaging…',
  'memory.triage.busyBody':
    'Reading {n} memory bodies with the claude CLI (one call; split into a few for very large projects). This usually takes 1–2 minutes; the page updates when it finishes.',
  'memory.triage.verdict.keep': 'Keep as is',
  'memory.triage.verdict.shrink': 'Shrink the body',
  'memory.triage.verdict.to-claude-md': 'Move to CLAUDE.md',
  'memory.triage.verdict.to-docs': 'Move to docs/',
  'memory.triage.verdict.delete': 'Delete',
  'memory.triage.verdict.wrong-project': 'Belongs elsewhere',
  'memory.triage.verdict.to-skill': 'Move to skill',
  'memory.triage.verdict.update': 'Rewrite the body',
  'memory.triage.openDetail': 'Open detail',
  'memory.triage.tpl.replace':
    '- Replace the body of {file} with the following (leave the index line as is)',
  'memory.triage.tpl.rule': '- Keep the first line (the rule) as is: "{rule}"',
  'memory.triage.tpl.whyKeep': '- Keep Why as is',
  'memory.triage.tpl.whyGeneralize':
    '- Rewrite Why as this one sentence (drop names and dates): "{text}"',
  'memory.triage.tpl.whyDrop': '- Delete Why (no value as a record of where the rule came from)',
  'memory.triage.tpl.howKeep': '- Keep How to apply as is',
  'memory.triage.tpl.howLines': '- In How to apply keep only the exceptions / boundaries: {list}',
  'memory.triage.tpl.howDrop': '- Delete How to apply (it restates the description)',
  'memory.triage.tpl.index': '- Do not change the MEMORY.md index line',
  'memory.triage.tpl.indexRewrite':
    '- Rewrite the description in the MEMORY.md index line to: "{text}" (it says something different from the body)',
  'memory.triage.tpl.indexAlign':
    '- The MEMORY.md index line and the body say different things: check which one is right and align them',
  /* wrong-project: the paths are decided by the server (from mechanical signals), only the wording lives here */
  'memory.triage.tpl.wpMove': '- This memory is about {target}, so move {file} to {dir}',
  'memory.triage.tpl.wpCheck':
    '- Before moving, check the destination does not already hold the same content',
  'memory.triage.tpl.wpIndex':
    '- Remove the matching line from the MEMORY.md index of this project',
  'memory.triage.tpl.wpIndexAdd':
    '- Add an index line for it to the MEMORY.md of the destination (reuse the current index line as the description)',
  'memory.triage.tpl.wpLink': '- Re-point [[link]] references from other memories',
  /* コピー本文の先頭に置く事実ヘッダ(モデル出力ではなくスキャン結果から機械生成) */
  'memory.triage.hdr.dir': 'Target: {dir} (project: {project})',
  'memory.triage.hdr.files': 'Target files: {files}',
  'memory.triage.hdr.unknownProject': 'unknown',
  'memory.triage.demoted': 'Needs checking',
  /* 格下げ件の理由文はモデルの見立てのまま(検証されていない)ことを前置きで示す */
  'memory.triage.demotedReason': "Model's view (unverified): ",
  'memory.triage.demotedTitle':
    'The model proposed a destination, but nothing here can back it mechanically (e.g. no path under another registered project, or the project itself could not be resolved), so it would have been guesswork. Held at "keep as is" — please check it yourself.',
  'memory.triage.skew':
    'The proposals are concentrated on a single destination. Check first whether the project identification (a mistaken path, or being treated as an unknown project) is wrong',
  'memory.signal.index-mismatch': 'Index line and body disagree',
  'memory.signal.other-project': 'Points at a path under another registered project: "{value}"',
  'memory.triage.verdict.error': 'Invalid output — re-run to retry',
  'memory.triage.seen': 'read {n}×',
  'memory.triage.unseen': 'no reads',
  'memory.triage.estApply': 'applied: index {n} tok/session',
  'memory.triage.estApplyClaude': 'applied: index {n} · always-on +{m} tok',
  'memory.triage.estShrink': 'applied: index ±0 · proposes shrinking the body',
  'memory.triage.estUpdate': 'applied: index ±0 · proposes rewriting the body',
  'memory.triage.instruction': 'Instruction to paste into Claude Code',
  'memory.triage.copy': 'Copy',
  'memory.triage.copied': 'Copied',
  'memory.triage.copyAll': 'Copy all {n} instructions',
  'memory.triage.footProposals': 'Proposals',
  'memory.triage.footProposalsUnit': 'items',
  'memory.triage.footApplied': 'If all applied',
  'memory.triage.footTokUnit': 'tok/session',
  'memory.triage.footDiff': 'Delta',
  'memory.triage.footDiffVal': '{n} tok',
  'memory.triage.footNote':
    'Copied instructions start with a "check first, then execute" preamble and include the destination path, removing the MEMORY.md index line and rewriting [[link]]s. To do only part of it, say so in the conversation you paste into.',
  'memory.triage.preambleLabel': 'Preamble for pasting (the copy buttons add it automatically)',
  'memory.triage.copyPreamble':
    'The following is a proposal from the skills-viewer memory triage. First inspect the current state read-only and present the exact work you would do. Where a judgment call is needed (several candidate destinations, the primary source cannot be located, the proposal conflicts with what you find, etc.), do not guess — ask me with AskUserQuestion. Execute only after I approve.',
  'memory.triage.whole': 'Triage the whole project →',
  'memory.triage.menu': 'Memory triage (current project)',
  'memory.triage.menuTitle':
    'Triage the auto memory of the current project: destination, reason and a pasteable instruction',
  'alert.triageFailed': 'Triage failed: {msg}',

  'detail.back': '← Back to list',
  'detail.lastUpdated': 'Last updated {date}',
  'detail.openEditor': 'Open in editor',
  'detail.copy': 'Copy ▾',
  'detail.resummarize': 'Refresh AI summary',
  'detail.summarizing': 'Summarizing…',
  'detail.delete': 'Delete',
  'tab.overview': 'Overview',
  'detail.aiSummary': 'AI summary',
  'detail.description': 'Description',
  'detail.usage': 'Usage',
  'detail.usageStats': 'Usage stats',
  'detail.usageDetail': 'Typed by human {typed}× · invoked by agent {auto}×',
  'detail.usageLast': ' · last {date}',
  'detail.relations': 'Related skills',
  'detail.notInstalled': 'not installed',
  'detail.files': 'Bundled files',
  'detail.path': 'Path',
  'detail.location': 'Location',
  'detail.builtinLocation': 'Bundled with Claude Code',
  'detail.sameName': 'Same-name definitions ({n})',
  'detail.open': 'Open',
  'detail.diff': 'diff',
  'detail.diffClose': 'Close diff',
  'changes.title': 'Since last launch:',
  'changes.added': '{n} added',
  'changes.updated': '{n} updated',
  'changes.removed': '{n} removed',
  'changes.more': '+{n} more',
  'changes.ack': 'Dismiss',
  'changes.ackTitle': 'Use the current state as the baseline for the next comparison',
  'alert.ackFailed': 'Failed to dismiss: {msg}',

  'detail.spark': 'Last 30 days',
  'detail.diagnostics': 'Diagnostics',
  'diag.run': 'AI trigger diagnosis',
  'diag.rerun': 'Re-diagnose',
  'diag.running': 'Diagnosing…',
  'diag.runTitle':
    'Analyze via claude CLI whether the description is likely to trigger auto-invocation, and propose an improved version',
  'diag.verdict.good': '✓ Trigger condition looks clear',
  'diag.verdict.weak': '△ Auto-invocation unlikely as written',
  'diag.improved': 'Suggested description',
  'diag.apply': 'Apply this suggestion',
  'diag.applying': 'Applying…',
  'alert.diagnoseFailed': 'Diagnosis failed: {msg}',
  'alert.applyFailed': 'Failed to apply: {msg}',

  'detail.flow': 'Flow',
  'flow.emptyHint':
    'No diagram yet. Extract the processing flow (steps, branches, delegations, human gates) from the definition body via claude CLI.',
  'flow.run': 'Diagram the flow (AI)',
  'flow.rerun': 'Re-extract flow',
  'flow.running': 'Extracting…',
  'flow.runTitle':
    'Extract the processing flow (steps, branches, delegations, human gates) from the definition body via claude CLI and render it as a diagram',
  'flow.gateHuman': 'human gate',
  'flow.yes': 'yes',
  'flow.no': 'no',
  'flow.done': 'done',
  'alert.flowFailed': 'Flow extraction failed: {msg}',

  'edit.button': 'Edit',
  'edit.save': 'Save',
  'edit.saving': 'Saving…',
  'edit.noFrontmatter': 'No frontmatter (--- block) found. Save anyway?',
  'alert.saveFailed': 'Save failed: {msg}',
  'detail.tokenCost':
    'Session overhead: ~{n} tokens (name + description are injected into every session; approx.)',
  'lint.no-description':
    'No description in frontmatter — the model has no basis to decide when to use this',
  'lint.short-description':
    'Description is very short (under 30 chars) — likely too little for the model to pick it',
  'lint.long-description': 'Description is very long (over 1024 chars) — it inflates every session',
  'lint.no-trigger':
    'No trigger condition (e.g. "Use when …") in the description — auto-invocation is unlikely',
  'lint.name-echo': 'Description merely repeats the name — it adds no signal',

  'diff.thisDef': '− {label} (this one)',
  'diff.identical': 'Contents are identical',
  'diff.changed': '{n} changed lines',
  'diff.skip': '… {n} identical lines …',
  'diff.failed': 'Failed to load diff: {msg}',
  'common.loading': 'Loading…',
  'common.cancel': 'Cancel',
  'common.close': 'Close',

  'alert.copyFailed': 'Copy failed: {msg}',
  'alert.deleteFailed': 'Delete failed: {msg}',
  'alert.trashed': 'Moved to trash:\n{path}',
  'alert.openFailed': 'Could not open in editor: {msg}',
  'alert.summarizeFailed': 'Summarization failed: {msg}',

  'delete.title': 'Delete {name}?',
  'delete.body': 'Moves SKILL.md and its bundled files to the trash (restorable later).',
  'delete.confirm': 'Delete',

  'copy.header': 'Copy to',

  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.aiModel': 'Model for AI features (summaries / diagnosis / grouping)',
  'settings.aiModelNote.haiku': 'Fast and cheap (default)',
  'settings.aiModelNote.sonnet': 'Higher quality; slower and costlier',
  'settings.aiModelNote.opus': 'Highest quality; slowest and most expensive',
  'settings.aiModelHint':
    'Aliases resolved by your claude CLI. Applies to new generations only — cached results stay until regenerated (force-rerun from ✦ AI to replace them)',
  'settings.width': 'Layout width',
  'settings.widthFull': 'Full width',
  'settings.widthFullNote': '4–5 columns on wide screens',
  'settings.widthFixed': 'Fixed width (1200px)',
  'settings.widthFixedNote': 'Centered, always 3 columns',
  'settings.editor': 'Editor used by "Open in editor"',
  'settings.customScheme': 'Custom URL scheme',
  'settings.osDefault': 'OS default',
  'settings.osDefaultNote': 'Opened server-side (default app for the file type)',
  'settings.save': 'Save',
  'settings.customNeedsPath':
    'A custom scheme must contain {path} (e.g. myeditor://open?file={path})',

  'invocation.human': 'Human',
  'invocation.agent': 'Agent',
  'invocation.both': 'Both',
  'invocation.measured': 'Measured: typed {typed}× / auto {auto}×',
  'invocation.ai': 'AI verdict: {label}',

  'rel.invokes': 'invokes',
  'rel.delegates': 'delegates',
  'rel.called-by': 'called by',
  'rel.references': 'references',

  'apiError.not-found': 'File not found: {detail}',
  'apiError.not-managed-path': 'Path is not managed here: {detail}',
  'apiError.plugin-managed': 'Plugin files are managed via the /plugin command',
  'apiError.not-md': 'Not a .md file: {detail}',
  'apiError.not-readable-path': 'Path is not readable here: {detail}',
  'apiError.not-openable-path': 'Path cannot be opened: {detail}',
  'apiError.unknown-copy-target': 'Unknown copy target: {detail}',
  'apiError.no-free-name': 'No free name for the copy',
  'apiError.unexpected-skill-dir': 'Unexpected skill directory layout: {detail}',
  'apiError.edit-conflict': 'The file was changed outside this app — reload the page and try again',
  'apiError.empty-content': 'Content is empty',
  'apiError.content-too-large': 'Content is too large to save',
  'apiError.bad-origin': 'Request rejected: bad origin',
  'apiError.bad-token': 'Bad token — reload the page (the server may have restarted)',
  'apiError.bad-json': 'Malformed request',
  'apiError.unknown-endpoint': 'Unknown API endpoint: {detail}',
  'apiError.internal': 'Server error: {detail}',
} as const;

export type MsgKey = keyof typeof en;

const ja: Record<MsgKey, string> = {
  'app.subtitle': 'skills · commands · agents · hooks · memory — このPCにインストール済み',
  'app.count': '{shown} / {total} 件',
  'app.searchPlaceholder': 'スキル名や説明で検索…',
  'app.settings': '設定',
  'app.loadFailed': '読み込みに失敗しました: {msg}',

  'sort.title': '並び順',
  'sort.name': '名前順',
  'sort.uses': '使用回数順',
  'sort.recent': '最近使った順',
  'sort.updated': '更新日順',
  'sort.tokens': 'トークン量順',
  'sort.memIndex': '索引トークンが多い順',
  'sort.memBody': '本文トークンが多い順',
  'sort.memStale': '更新が古い順',
  'kind.all': 'すべて',
  'filter.used': '直近使用あり',
  'filter.usedTitle': '保持期間内(既定30日)のトランスクリプトに使用記録があるものだけ表示',
  'filter.unused': '直近使用なし',
  'filter.unusedTitle': '保持期間内(既定30日)のトランスクリプトに使用記録がないものだけ表示',

  'ai.button': 'AI要約',
  'ai.progress': '要約中 {done}/{total}',
  'ai.stale': 'AI要約 (未生成 {n})',
  'ai.done': 'AI要約 ✓',
  'ai.buttonTitle':
    'claude CLI で各 SKILL.md を要約(モデルは設定で変更可)。内容が変わったものだけ再生成',
  'ai.confirmForce': '全 skill の要約は最新です。全 {n} 件を強制再生成しますか?(claude CLI)',
  'ai.confirmRun': '{n} 件の SKILL.md を claude CLI で要約します。よろしいですか?',
  'ai.finishedErrors': '要約完了(エラー {n}件):',
  'ai.startFailed': '開始に失敗: {msg}',

  'view.source': 'ソース別',
  'view.group': '用途別',
  'view.memory': 'メモリ',
  'view.flat': 'フラット',
  'view.title': '表示軸: 置き場所別 / 使いどき別 / 自動メモリ / 1つのリスト',
  'filter.kindPrefix': '種類: {v}',
  'filter.usePrefix': '使用: {v}',
  'filter.refPrefix': '参照: {v}',
  'filter.refRead': '参照あり',
  'filter.refUnread': '参照なし',
  'filter.refTitle':
    'トランスクリプト保持期間内(既定30日)に本文が Read されたか。トランスクリプトが無いプロジェクトはどちらにも含めません',
  'ai.menu': '✦ AI',
  'ai.menuTitle': 'AI 操作: 要約と用途グルーピング(claude CLI)',
  'group.other': 'その他',
  'group.manual': '手動',
  'group.manualTitle': 'frontmatter の category による手動指定(AI 分類より優先)',
  'group.generate': '✦ 用途で分類 (AI)',
  'group.generating': '分類中…',
  'group.generateTitle':
    'インストール済みの全アイテムを「いつ使うか」で分類します(環境全体で claude CLI を1回呼び出し)',
  'group.empty':
    'まだ用途グループがありません。claude CLI の1回の呼び出しで、インストール済みの全アイテムを「いつ使うか」で分類します。',
  'group.stale': '前回の分類後にスキル構成が変わっています',
  'group.staleAction': '「✦ AI」メニューから再分類できます',
  'group.menuGenerate': '用途グループを生成',
  'group.menuRegen': '用途グループを再分類',
  'alert.groupFailed': '分類に失敗: {msg}',

  'list.empty': '条件に一致するスキルがありません',
  'card.uses': '使用 {n}回 · 最終 {date}',
  'card.noUses': '使用記録なし',
  'card.updated': '{date} 更新',
  'card.tokens': '約{n}tok',
  'badge.unused': '直近未使用',
  'badge.unusedTitle':
    'トランスクリプト保持期間内(既定30日)に使用記録がありません。それ以前の使用は集計できません',
  'badge.warnTitle': 'description の問題:',
  'sec.tokens': '≈{n}tok/セッション',
  'app.tokens': '≈{n}トークン/セッション',
  'app.tokensTitle':
    '現在のプロジェクトでのセッションごとに注入されるトークンの概算(built-in・plugin・user・現在プロジェクトの name + description)',

  'memory.searchPlaceholder': 'memory を検索…',
  'memory.secLabel': 'MEMORY — {name}',
  'memory.secPath': 'パス: {path}',
  'memory.secMemDir': 'memory ディレクトリ: {path}',
  'memory.orphan': 'プロジェクト不明',
  'memory.orphanTitle':
    '対応するプロジェクトが見つかりません(外部ボリューム未マウント・削除済み worktree の残骸・プロジェクトの登録抹消などが考えられます。エンコードされたディレクトリ名から元のパスを復元できるとは限りません)',
  'memory.type.user': '人物像',
  'memory.type.feedback': '指示・方針',
  'memory.type.project': '進行状況',
  'memory.type.reference': '参照先',
  'memory.today': '今日 更新',
  'memory.stale': '{n}日 更新なし',
  'memory.secTokensTitle':
    'このプロジェクトの MEMORY.md の索引行の概算トークン。索引は全メモリ分が、本文を読むかどうかに関わらず毎セッション注入されます',
  'memory.idx': '索引',
  'memory.body': '本文',
  'memory.indexTokTitle':
    '常時コスト: このメモリの MEMORY.md 上の索引行。毎セッション注入されます(0 = 索引に載っていない)',
  'memory.bodyTokTitle': '従量コスト: 本文全体。Read されたときだけかかります',
  'memory.readsTitle':
    'トランスクリプト保持期間内(既定30日)にこのメモリが Read された回数。0 でも「一度も読まれていない」ことは意味しません',
  'memory.writesTitle':
    'トランスクリプト保持期間内にこのメモリが作成・更新された回数(Write / Edit)',
  'memory.unread': '直近未参照',
  'memory.unreadTitle':
    'トランスクリプト保持期間内(既定30日)に本文が Read されていません。索引行だけで機能するメモリでは正常な状態です',
  'memory.linkBrokenTitle': 'このプロジェクトに同名のメモリがありません',
  'memory.brokenBadgeTitle': 'このプロジェクトに解決先が無い [[link]]: {n} 件',

  'memory.cost.indexK': '索引 — 毎セッション',
  'memory.cost.indexNote': '{n} 件ぶんの索引行が\n無条件で毎回注入される',
  'memory.cost.bodyK': '本文 — 参照時のみ',
  'memory.cost.bodyNote': '読まれない限り 0 コスト。\n保持期間内に参照 {k} / {n} 件',
  'memory.cost.bodyNoteNA': '読まれない限り 0 コスト。\n参照実績は計測不能(transcript なし)',
  'memory.cost.perK': '1 件あたり',
  'memory.cost.perNote': '減らせるのは件数のみ。\n本文を短くしても索引は変わらない',
  'memory.cost.unit': 'tok',
  'memory.cmp.memory': 'memory 索引',
  'memory.cmp.plugin': 'plugin',
  'memory.cmp.user': 'user skill',
  'memory.cmpTitle':
    'この環境の他の常時注入元との比較(plugin / user skill は name + description の合計)',

  'memory.card.reads': '本文 {n} 回参照 · 最終 {date}',
  'memory.card.noReads': '本文の参照記録なし',
  'memory.card.noReadsFeedback': '本文の参照記録なし — 索引行だけで機能している',
  'memory.card.na': '参照実績は計測不能',

  'memory.back': '← 一覧',
  'memory.tab.body': '本文',
  'memory.warnline': 'リンク切れ {n} 件: {names}',
  'memory.sec.cost': 'コンテキストコスト',
  'memory.sec.reads': '参照実績',
  'memory.sec.links': 'リンク',
  'memory.sec.frontmatter': 'frontmatter',
  'memory.cbox.indexK': '索引行 — 毎セッション',
  'memory.cbox.indexNote':
    'MEMORY.md の 1 行として、このプロジェクトで作業するたび無条件に注入されます。',
  'memory.cbox.bodyRead': '読まれたときだけ課金。保持期間内に {n} 回参照。',
  'memory.cbox.bodyUnread': '読まれたときだけ課金。保持期間内の参照記録はありません。',
  'memory.cbox.bodyNA': '読まれたときだけ課金。参照実績は計測不能(transcript なし)。',
  'memory.f.reads': '本文の参照',
  'memory.f.writes': '作成・更新',
  'memory.f.origin': '生成元セッション',
  'memory.f.times': '{n} 回',
  'memory.f.last': ' — 最終 {date}',
  'memory.f.none': 'なし',
  'memory.f.noneNote': ' — トランスクリプト保持期間内',
  'memory.f.na': '計測不能',
  'memory.linkDead': '{name}(リンク切れ)',

  'memory.triage.section': '✦ 棚卸し診断',
  'memory.triage.sectionTitle':
    'このプロジェクトのメモリの行き先を AI に診断させ、Claude Code に貼れる指示文を作ります',
  'memory.triage.heading': '棚卸し診断',
  'memory.triage.back': '← Memory 一覧',
  'memory.triage.title': '棚卸し診断 — {project}',
  'memory.triage.sub':
    '✦ このツールは実行しません。提案ごとに、Claude Code に貼る指示文を用意します',
  'memory.triage.run': '診断を実行',
  'memory.triage.running': '診断中…',
  'memory.triage.rerun': '再診断',
  'memory.triage.runTitle':
    '全メモリの本文を 1 回の claude 呼び出しで読み、行き先を提案します(件単位キャッシュ。変更された件だけ再診断)',
  'memory.triage.rerunTitle':
    'キャッシュを無視して全件を診断し直します(claude を呼びます。通常 1 回、件数が非常に多いときは数回)',
  'memory.triage.summary': '{n} 件を診断 — {p} 件に提案、{k} 件は現状維持',
  'memory.triage.summaryWithErrors':
    '{n} 件を診断 — {p} 件に提案、{k} 件は現状維持、{e} 件は出力不正',
  'memory.triage.summaryPending': '{n} 件中 {u} 件が未診断',
  'memory.triage.ctaTitle': 'まだ診断していません',
  'memory.triage.ctaBody':
    'AI はまだ何も読んでいません(下の行は事実の表示だけ)。「診断を実行」で {n} 件の本文を claude で読み(通常 1 回、件数が非常に多いときは数回に分割)、1 件ごとに行き先と貼れる指示文を出します(通常 1〜2 分)。',
  'memory.triage.ctaPartial':
    '前回の診断から {n} 件中 {u} 件が変更されています。「診断を実行」でその {u} 件だけを claude で診断し直します。',
  'memory.triage.busyTitle': '診断中…',
  'memory.triage.busyBody':
    '{n} 件の本文を claude で読んでいます(通常 1 回、件数が非常に多いときは数回に分割)。通常 1〜2 分かかります。終わると画面が更新されます。',
  'memory.triage.verdict.keep': 'このまま',
  'memory.triage.verdict.shrink': '本文を縮める',
  'memory.triage.verdict.to-claude-md': 'CLAUDE.md へ',
  'memory.triage.verdict.to-docs': 'docs/ へ',
  'memory.triage.verdict.delete': '削除',
  'memory.triage.verdict.wrong-project': '別プロジェクトの話',
  'memory.triage.verdict.to-skill': 'skill へ',
  'memory.triage.verdict.update': '本文を書き直す',
  'memory.triage.openDetail': '詳細を開く',
  'memory.triage.tpl.replace': '- {file} の本文を次の構成に置き換える(索引行は変更しない)',
  'memory.triage.tpl.rule': '- 1 行目(ルール)はそのまま残す: 「{rule}」',
  'memory.triage.tpl.whyKeep': '- Why はそのまま残す',
  'memory.triage.tpl.whyGeneralize':
    '- Why を次の 1 文に書き換える(固有名詞・日付を落とす): 「{text}」',
  'memory.triage.tpl.whyDrop': '- Why は削除する(出自の記録としての価値が無い)',
  'memory.triage.tpl.howKeep': '- How to apply はそのまま残す',
  'memory.triage.tpl.howLines': '- How to apply は例外・境界の行だけ残す: {list}',
  'memory.triage.tpl.howDrop': '- How to apply は description の再掲なので削除する',
  'memory.triage.tpl.index': '- MEMORY.md の索引行は変更しない',
  'memory.triage.tpl.indexRewrite':
    '- MEMORY.md の索引行の description を「{text}」に書き換える(本文と異なる境界を言っているため)',
  'memory.triage.tpl.indexAlign':
    '- MEMORY.md の索引行と本文が違うことを言っている。どちらが正しいか確認して揃える',
  'memory.triage.tpl.wpMove': '- この memory は {target} の話なので、{file} を {dir} へ移す',
  'memory.triage.tpl.wpCheck': '- 移動先に同じ内容が無いか確認してから移す',
  'memory.triage.tpl.wpIndex': '- このプロジェクトの MEMORY.md の該当索引行を削除する',
  'memory.triage.tpl.wpIndexAdd':
    '- 移動先の MEMORY.md に索引行を追加する(description は現行の索引行を流用)',
  'memory.triage.tpl.wpLink': '- 他メモリからの [[link]] を張り替える',
  'memory.triage.hdr.dir': '対象: {dir}(プロジェクト: {project})',
  'memory.triage.hdr.files': '対象ファイル: {files}',
  'memory.triage.hdr.unknownProject': '不明',
  'memory.triage.demoted': '要確認',
  'memory.triage.demotedReason': 'AI の見立て(未検証): ',
  'memory.triage.demotedTitle':
    'AI は行き先を提案しましたが、機械的な裏付け(別の登録プロジェクト配下のパスや、プロジェクトへの逆引きなど)が無く、推測になるため「このまま」に留めました。内容はご自身で確認してください。',
  'memory.triage.skew':
    '提案が 1 種類に偏っています。プロジェクトの特定(パスの取り違え・プロジェクト不明扱い)が誤っている可能性を先に確認してください',
  'memory.signal.index-mismatch': '索引行と本文が食い違っています',
  'memory.signal.other-project': '別の登録プロジェクト「{value}」配下のパスを指しています',
  'memory.triage.verdict.error': '出力不正 — 再診断で再試行',
  'memory.triage.seen': '{n} 回参照',
  'memory.triage.unseen': '参照なし',
  'memory.triage.estApply': '適用で 索引 {n} tok/セッション',
  'memory.triage.estApplyClaude': '適用で 索引 {n} · 常時 +{m} tok',
  'memory.triage.estShrink': '適用で 索引 ±0 · 本文を縮める提案',
  'memory.triage.estUpdate': '適用で 索引 ±0 · 本文を書き直す提案',
  'memory.triage.instruction': 'Claude Code への指示文',
  'memory.triage.copy': 'コピー',
  'memory.triage.copied': 'コピーしました',
  'memory.triage.copyAll': '{n} 件分の指示文をまとめてコピー',
  'memory.triage.footProposals': '提案',
  'memory.triage.footProposalsUnit': '件',
  'memory.triage.footApplied': '全て適用したとき',
  'memory.triage.footTokUnit': 'tok/セッション',
  'memory.triage.footDiff': '差分',
  'memory.triage.footDiffVal': '{n} tok',
  'memory.triage.footNote':
    'コピーした指示文には「まず確認してから実行」の前置きが付き、移動先パス・MEMORY.md の索引行の削除・[[link]] の張り替えまで含まれます。一部だけやりたいときは、貼った先の会話でそう伝えてください。',
  'memory.triage.preambleLabel': '貼るときの前置き(コピーボタンでは自動で付きます)',
  'memory.triage.copyPreamble':
    '以下は skills-viewer の memory 棚卸し診断からの提案です。まず読み取りだけで現状を確認し、実行する作業内容を提示してください。判断が必要な点(移動先の候補が複数ある、一次情報の所在が分からない、提案と実態が食い違う、など)があれば推測せず AskUserQuestion で私に確認してください。実行は承認を得てからにしてください。',
  'memory.triage.whole': 'プロジェクト全体を棚卸し →',
  'memory.triage.menu': 'memory 棚卸し(現在のプロジェクト)',
  'memory.triage.menuTitle':
    '現在のプロジェクトの自動メモリを棚卸しし、行き先・理由・貼れる指示文を出します',
  'alert.triageFailed': '棚卸し診断に失敗: {msg}',

  'detail.back': '← 一覧に戻る',
  'detail.lastUpdated': '最終更新 {date}',
  'detail.openEditor': 'エディタで開く',
  'detail.copy': 'コピー ▾',
  'detail.resummarize': 'AI要約更新',
  'detail.summarizing': '要約中…',
  'detail.delete': '削除',
  'tab.overview': '概要',
  'detail.aiSummary': 'AI 要約',
  'detail.description': '説明',
  'detail.usage': '使い方',
  'detail.usageStats': '使用実績',
  'detail.usageDetail': '手動(人間がタイプ) {typed}回 · 自動(エージェント呼び出し) {auto}回',
  'detail.usageLast': ' · 最終 {date}',
  'detail.relations': '関連スキル',
  'detail.notInstalled': '未インストール',
  'detail.files': '含まれるファイル',
  'detail.path': 'パス',
  'detail.location': '場所',
  'detail.builtinLocation': 'Claude Code 本体に同梱',
  'detail.sameName': '同名の定義 ({n})',
  'detail.open': '開く',
  'detail.diff': 'diff',
  'detail.diffClose': 'diff を閉じる',
  'changes.title': '前回の起動から:',
  'changes.added': '追加 {n}',
  'changes.updated': '更新 {n}',
  'changes.removed': '削除 {n}',
  'changes.more': '他 {n} 件',
  'changes.ack': '既読にする',
  'changes.ackTitle': '現在の状態を次回比較の基準として保存します',
  'alert.ackFailed': '既読化に失敗: {msg}',

  'detail.spark': '直近30日',
  'detail.diagnostics': '診断',
  'diag.run': 'AI 発動診断',
  'diag.rerun': '再診断',
  'diag.running': '診断中…',
  'diag.runTitle': 'description が自動発動につながるかを claude CLI で分析し、改善案を提案します',
  'diag.verdict.good': '✓ 発動条件は明確です',
  'diag.verdict.weak': '△ このままでは自動発動されにくい可能性',
  'diag.improved': '改善案',
  'diag.apply': 'この案を適用',
  'diag.applying': '適用中…',
  'alert.diagnoseFailed': '診断に失敗: {msg}',
  'alert.applyFailed': '適用に失敗: {msg}',

  'detail.flow': 'フロー',
  'flow.emptyHint':
    'まだ図解がありません。定義本文から処理フロー(ステップ・分岐・委譲・人間ゲート)を claude CLI で抽出します。',
  'flow.run': 'フローを図解 (AI)',
  'flow.rerun': 'フローを再抽出',
  'flow.running': '抽出中…',
  'flow.runTitle':
    '定義本文から処理フロー(ステップ・分岐・委譲・人間ゲート)を claude CLI で抽出し、図として表示します',
  'flow.gateHuman': '人間ゲート',
  'flow.yes': 'はい',
  'flow.no': 'いいえ',
  'flow.done': '完了',
  'alert.flowFailed': 'フロー抽出に失敗: {msg}',

  'edit.button': '編集',
  'edit.save': '保存',
  'edit.saving': '保存中…',
  'edit.noFrontmatter': 'frontmatter(--- ブロック)がありません。このまま保存しますか?',
  'alert.saveFailed': '保存に失敗: {msg}',
  'detail.tokenCost':
    'セッションあたりの負荷: 約{n}トークン(name + description は毎セッション注入されます。概算)',
  'lint.no-description':
    'frontmatter に description がありません — モデルが使いどきを判断する材料がありません',
  'lint.short-description':
    'description が短すぎます(30文字未満)— モデルが選ぶ手掛かりとして不足しがちです',
  'lint.long-description': 'description が長すぎます(1024文字超)— 毎セッションの負荷になります',
  'lint.no-trigger':
    'description に発動条件(「〜のときに使用」等)がありません — 自動発動されにくくなります',
  'lint.name-echo': 'description が名前の繰り返しになっています — 情報が増えていません',

  'diff.thisDef': '− {label}(この定義)',
  'diff.identical': '内容は同一です',
  'diff.changed': '差分 {n} 行',
  'diff.skip': '… {n} 行同一 …',
  'diff.failed': 'diff の取得に失敗しました: {msg}',
  'common.loading': '読み込み中…',
  'common.cancel': 'キャンセル',
  'common.close': '閉じる',

  'alert.copyFailed': 'コピーに失敗: {msg}',
  'alert.deleteFailed': '削除に失敗: {msg}',
  'alert.trashed': 'ゴミ箱に移動しました:\n{path}',
  'alert.openFailed': 'エディタで開けませんでした: {msg}',
  'alert.summarizeFailed': '要約に失敗: {msg}',

  'delete.title': '{name} を削除しますか?',
  'delete.body': 'SKILL.md と関連ファイルをゴミ箱に移動します(あとで復元できます)。',
  'delete.confirm': '削除する',

  'copy.header': 'コピー先のリスト',

  'settings.title': '設定',
  'settings.language': '言語',
  'settings.aiModel': 'AI 機能のモデル(要約 / 診断 / グルーピング)',
  'settings.aiModelNote.haiku': '速い・安価(既定)',
  'settings.aiModelNote.sonnet': '高品質。やや遅く高コスト',
  'settings.aiModelNote.opus': '最高品質。最も遅く高コスト',
  'settings.aiModelHint':
    'claude CLI のエイリアスとして解決されます。次回の生成から適用され、生成済みキャッシュはそのまま残ります(置き換えたい場合は ✦ AI から強制再生成)',
  'settings.width': '表示幅',
  'settings.widthFull': 'フル幅',
  'settings.widthFullNote': '広い画面では 4〜5 カラム',
  'settings.widthFixed': '固定幅 (1200px)',
  'settings.widthFixedNote': '中央寄せ・常に 3 カラム',
  'settings.editor': '「エディタで開く」で使うエディタ',
  'settings.customScheme': 'カスタム URL スキーム',
  'settings.osDefault': 'OS デフォルト',
  'settings.osDefaultNote': 'サーバー側で開く(拡張子の既定アプリ)',
  'settings.save': '保存',
  'settings.customNeedsPath':
    'カスタムスキームには {path} を含めてください(例: myeditor://open?file={path})',

  'invocation.human': '人間起点',
  'invocation.agent': 'エージェント',
  'invocation.both': '両方',
  'invocation.measured': '実測: 手動 {typed}回 / 自動 {auto}回',
  'invocation.ai': 'AI判定: {label}',

  'rel.invokes': '起動',
  'rel.delegates': '委譲',
  'rel.called-by': '呼ばれる側',
  'rel.references': '参照',

  'apiError.not-found': 'ファイルが見つかりません: {detail}',
  'apiError.not-managed-path': '管理対象外のパスです: {detail}',
  'apiError.plugin-managed': 'plugin 配下は /plugin コマンドで管理してください',
  'apiError.not-md': 'md ファイルではありません: {detail}',
  'apiError.not-readable-path': '読み取り対象外のパスです: {detail}',
  'apiError.not-openable-path': '対象外のパスです: {detail}',
  'apiError.unknown-copy-target': '未知のコピー先です: {detail}',
  'apiError.no-free-name': 'コピー先の空き名が見つかりません',
  'apiError.unexpected-skill-dir': 'skill ディレクトリ構造が想定外です: {detail}',
  'apiError.edit-conflict':
    'ファイルが外部で変更されています。ページを再読み込みしてからやり直してください',
  'apiError.empty-content': '内容が空です',
  'apiError.content-too-large': '内容が大きすぎて保存できません',
  'apiError.bad-origin': '不正なオリジンからのアクセスです',
  'apiError.bad-token':
    'トークンが不正です。ページを再読み込みしてください(サーバー再起動の可能性)',
  'apiError.bad-json': '不正なリクエストです',
  'apiError.unknown-endpoint': '不明な API です: {detail}',
  'apiError.internal': 'サーバーエラー: {detail}',
};

const DICTS: Record<Lang, Record<MsgKey, string>> = { en, ja };

/* ---- 言語の状態 ---- */

const LS_KEY = 'csb-lang';

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored === 'ja' || stored === 'en') return stored;
    return /^ja/i.test(navigator.language) ? 'ja' : 'en';
  } catch {
    return 'en'; // ブラウザ外(テスト等)
  }
}

let current: Lang = detectLang();

export const getLang = (): Lang => current;

export function setLang(l: Lang): void {
  current = l;
  try {
    localStorage.setItem(LS_KEY, l);
    document.documentElement.lang = l;
  } catch {
    /* ブラウザ外では何もしない */
  }
}

/* ---- 変換 ---- */

/* {name} を params の値で置換。params に無いプレースホルダはそのまま残す */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  let s: string = DICTS[current][key];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', String(v));
  }
  return s;
}

export const relTypeLabel = (type: RelationType): string => t(`rel.${type}`);

export const lintLabel = (code: LintCode): string => t(`lint.${code}`);

/* memory の type は「スコープ」と誤読されやすいので、内容分類として意訳したラベルを引く */
export const memoryTypeLabel = (type: MemoryType): string => t(`memory.type.${type}`);

/* 棚卸し診断の行き先ラベル(verdict は言語非依存キー) */
export const memoryVerdictLabel = (verdict: MemoryVerdict): string =>
  t(`memory.triage.verdict.${verdict}`);

/* API エラー {error: code, detail} を表示文言に変換。未知コードは code: detail をそのまま出す */
export function apiErrorMessage(body: unknown, status: number): string {
  const b = (body || {}) as { error?: unknown; detail?: unknown };
  const code = typeof b.error === 'string' ? b.error : '';
  const detail = typeof b.detail === 'string' ? b.detail : '';
  const key = ('apiError.' + code) as MsgKey;
  if (code && key in en) return t(key, { detail });
  if (code) return detail ? `${code}: ${detail}` : code;
  return 'HTTP ' + status;
}
