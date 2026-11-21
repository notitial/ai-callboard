"""Lets callboard open a Claude Code panel in any folder of a multi-folder VS Code window. Checks unless --apply, --update or --undo.

  /usr/bin/python3 -I patch-claude.py EXTENSION_DIR [--apply | --update | --undo]
      EXTENSION_DIR is one installed Claude Code extension folder, for example ~/.vscode/extensions/anthropic.claude-code-<version>-<platform>.
      No flag: change nothing and print one line, the state and the extension's version, then what it means:
        patched                  the patch is in, its marker matches the file and it is what this script would build now
                                 (with no backup that matches the marker, there is nothing to build from, and the marker decides)
        outdated <why>           the patch is in but an older script built it (the line names what differs): --update brings it current
        unpatched-patchable      every anchor was found exactly once: --apply would patch it
        anchors-missing <names>  an update moved the code the patch hooks into (a name is missing or matches twice): --apply refuses
      --apply: patch extension.js, keep the original beside it as extension.js.callboard-orig and write callboard-cwd-patch.json
      (the marker callboard's panels extension reads; its "width", "pie", "pill", "restore", "groups" and "session" fields say whether the panel width, the context pie, the folder pill, the restore fix, the group command and the session command below went in). Patched already: says so and stops; outdated: refuses and names --update. A window reload (Developer: Reload
      Window) loads it.
      --update: for an `outdated` install, build the patch again from the backup original and swap it in: extension.js and the marker are
      replaced (and webview/index.js, when the context pie or the folder pill is or goes in or out), the backups are not touched. The new bytes are built before anything is written (a refusal changes nothing), and a failed write puts the
      previous patched files back. Any other state: the same as --apply. An install made by a script that still hid the Remote Control chip reads outdated: --update leaves the chip out.
      --undo: put the original back from the backup (webview/index.js too, when the pie or the pill was in) and remove the backups and the marker.

The patch gives `claude-vscode.editor.open` a `cwd` in its sixth argument ({cwd: folder}), which becomes the working folder of the
new panel instead of the window's first folder, when it is one of the window's folders (4 edits). A fresh panel opened by a + New session button
(a call with an options object but no `cwd` or session id) in a window with several folders first shows VS Code's own folder list and uses the pick; Escape
opens nothing; a bare call (the palette, Open, an @-mention), a resume and a one-folder window never ask. The panel width (WIDTH_CSS below, a style block added to the webview page the extension builds) lets the composer and its permission box use the panel's
width. Each anchor is a pattern that tolerates renamed minified
identifiers, and the file is written only when every anchor matches exactly once: otherwise nothing changes and the missing ones
are named. The optional pieces are separate: the width block goes in when the font tag matches exactly once and the shipped webview has its tokens, the context pie (PIE_ANCHORS below: the composer's stock pie shown always, as one ring,
against the autocompact level of the settings, in webview/index.js, kept as webview/index.js.callboard-orig) goes in when the font tag and its three anchors there each match once, the folder pill (PILL_ANCHOR below: a name for the session's folder next to the model name in the composer, in webview/index.js, read from <folder>/.archive/.folder and renamed by a click, which asks the extension: PILL_HANDLER_ANCHOR, in extension.js) goes in when its one anchor in each
matches once, the restore fix
(RESTORE_ANCHORS below: a panel that VS Code restores or Claude reopens keeps the folder of its conversation, found from the session's transcript) goes in
when its two anchors do, and the group command (GROUPS_ANCHOR below) registers `callboard assign group` (session id, group name), so callboard's panels
extension can put a lead or lane session in the sidebar's Lead or Lanes group, when its one anchor matches exactly once, and the session command (at the same anchor) registers `callboard active session`, which
returns the session id of the Claude panel in front, for the panels extension's folder badge; when one does not, a warning line says so and the folder patch still applies. There is no half patch: a failure after the file was replaced puts the backup back. An update of the extension is a new
folder, so it starts unpatched and this runs again. It never uses the network, runs nothing else, works only inside EXTENSION_DIR
and changes no setting. Run it as your user: it refuses root. Tests: /usr/bin/python3 -I tools/callboard/test_patch_claude.py
Exit codes: 0 done or nothing to do (patched, patchable), 1 refused, outdated or anchors missing, 2 usage.
"""
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

MAIN = "extension.js"
BACKUP = "extension.js.callboard-orig"
PREVIOUS = "extension.js.callboard-prev"
MARKER = "callboard-cwd-patch.json"
WEB = "webview/index.js"
WEB_BACKUP = WEB + ".callboard-orig"
PATCH = 1
NAME = b"cbCwd"
ID = rb"[A-Za-z_$][\w$]*"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")

# The CSS pieces: each a style block of its own in the webview page the extension builds, put in front of the font configuration style tag. That tag
# is the one anchor they share: it still matches once after each insert. The rules carry !important, so they win over the page's own. Each block ends
# up inside a JavaScript template literal, so it holds no backtick or backslash, and no "${" but the pie's one (below). Class names of the page carry a build hash, so the selectors match their
# stable prefix. A rule whose selector goes stale does not fail, so a piece goes in only when the shipped webview (webview/index.css and index.js) still carries
# every token it names; one that misses is left out with a warning and the others still apply.
CSS_ANCHOR = b'<style id="claude-font-configuration">'
# The panel width: the composer and its permission box use the panel's width. CONFIRMED against the shipped index.css: the 680px cap on `inputWrapper_` and
# `permissionsContainer_` (both centred with margin:0 auto). A GUESS, which only a rendered panel can confirm: `inputContainer_`, the composer's outer box
# (absolute, max-width 680px, left and right 16px). The guess is limited to the rule that has no `data-permission-mode`, because the inner box of the same prefix
# has it. If the side margin does not change, find the element that holds the margin in the window's developer tools and change that selector and the 8px.
WIDTH_CSS = (
    '[class*="inputWrapper_"],[class*="permissionsContainer_"]{max-width:none!important}'
    '[class*="inputContainer_"]:not([data-permission-mode]){max-width:none!important;left:8px!important;right:8px!important}'
)
# (marker field, name in messages, the name of its CSS in this module, the tokens the shipped webview must carry).
CSS_PIECES = (
    ("width", "panel width", "WIDTH_CSS", ("inputWrapper_", "permissionsContainer_", "inputContainer_")),
)


# (label, pattern, replacement). The replacement gets the match; each pattern is checked on the unpatched file.
ANCHORS = (
    ("createPanel signature",
     rb"(async createPanel\((?:ID,){7}ID=!1)\)\{".replace(b"ID", ID),
     lambda m: m.group(1) + b"," + NAME + b"){"),
    ("createPanel's setupPanel call",
     rb"(this\.setupPanel\(ID,ID,ID,ID,ID===!0,ID)\)".replace(b"ID", ID),
     lambda m: m.group(1) + b"," + NAME + b")"),
    ("setupPanel start",
     rb"(setupPanel\((?:ID,){5}ID=!1)\)\{(this\.panelFullEditor\.set\(ID,!!ID\);let (ID)=ID\.workspace\.workspaceFolders\?\.map\(\((ID)\)=>\4\.uri\.fsPath\)"
     rb"\|\|\[\],ID=ID\()\3\)".replace(b"ID", ID),
     lambda m: m.group(1) + b"," + NAME + b"){" + m.group(2) + m.group(3) + b".includes(" + NAME + b")?[" + NAME + b"]:" + m.group(3) + b")"),
    ("editor.open command",
     rb'("claude-vscode\.editor\.open",async\((?P<args>(?:ID,){4}ID),(?P<opt>ID)\)=>\{[\s\S]{0,1500}?)(?P<decl>let\{[^{}]{1,80}\}=await ID)\.createPanel\((?P=args),(?P<fi>ID\.focusInput)\)'.replace(b"ID", ID),
     lambda m: m.group(1) + b"let cbqC=await " + pick(m.group("args").split(b",")[0], m.group("opt")) + b";if(cbqC===null)return;" + m.group("decl")
     + b".createPanel(" + m.group("args") + b"," + m.group("fi") + b",void 0,!1,cbqC)"),
)


def css_tag(field):
    return b'<style id="callboard-' + field.encode() + b'">'


def css_problem(raw, web, field, tokens):
    """Why a CSS piece cannot go in (None when it can): the font tag does not match exactly once, the page already has the block, or the webview lacks a token."""
    n = raw.count(CSS_ANCHOR)
    if n != 1:
        return "font tag anchor (%s)" % ("no match" if n == 0 else "%d matches" % n)
    if css_tag(field) in raw:
        return "the file already contains callboard-%s" % field
    miss = [t for t in tokens if t.encode() not in b"".join(web)]
    return "the webview lacks %s" % ", ".join(miss) if miss else None


def css_in(raw, field, css):
    return raw.replace(CSS_ANCHOR, css_tag(field) + css.encode("ascii") + b"</style>" + CSS_ANCHOR, 1)


# The context pie. The composer's stock pie is hidden until half of the context is used, has three fixed shapes, and measures against the model's window, not the
# autocompact level of the person's settings. This piece shows it always, as one ring, against that level. It edits webview/index.js (its own backup, WEB_BACKUP)
# in three places, and puts the level into the page as the CSS variable --callboard-compact: the pie's style block, in extension.js, reads `autoCompactWindow` from
# <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json each time a panel's page is built (0 when it is not a number above 0; project settings are not read). Where the
# level is below the model's window, the stock threshold (window - the smaller of the output limit and 20000 - 13000) is taken from the level instead of the window.
# The three anchors are patterns on the minified code; the piece goes in only when each matches exactly once in the shipped index.js and the font tag matches once.
# The ring is drawn 16px wide (its viewBox stays 20, so the stroke scales). The composer's footer stylesheet sizes the button and its svg to 26px, which wins over the
# svg's width attribute, so the pie's style block also sets the svg to 16px and the button to fit it with 2px around (the attribute is the fallback when the class
# names change). The hover text is `used/limit` in k (126k/200k) in place of Claude Code's "37% of
# context remaining until auto-compact. Click to compact now.": the pie component hands the used tokens and its limit (its window, where the ring is full) to the
# tooltip component. That is PIE_TIP_ANCHORS, two edits that go in together; when either does not match exactly once in the shipped script, the ring is still the
# new one and the hover text stays Claude Code's.
PIE_CSS = (
    ":root{--callboard-compact:${(()=>{try{let p=require(\"path\"),n=JSON.parse(require(\"fs\").readFileSync(p.join(process.env.CLAUDE_CONFIG_DIR||"
    "p.join(require(\"os\").homedir(),\".claude\"),\"settings.json\"),\"utf8\")).autoCompactWindow;return Number.isInteger(n)&&n>0?n:0}catch{return 0}})()}}"
    '[class*="usageButtonV2_"]{width:auto!important;height:auto!important;padding:2px!important}[class*="usageButtonV2_"] svg{width:16px!important;height:16px!important}'
)
PIE_CAP = (
    b'var cbpN;function cbpCap(cbpW){cbpN??=parseInt(getComputedStyle(document.documentElement).getPropertyValue("--callboard-compact"))||0;'
    b"return cbpN>0&&cbpW>cbpN?cbpN:cbpW}"
)
PIE_ANCHORS = (
    ("pie component",
     rb"(function ID\(\{usedTokens:ID,contextWindow:(ID),onCompact:ID,buttonClassName:ID\}\)\{let ID=\2>0\?Math\.min\(ID/\2\*100,100\):0,ID=100-ID;if\(\2===0\)return null;)if\(ID>=50\)return null;".replace(b"ID", ID),
     lambda m: PIE_CAP + m.group(1)),
    ("pie drawing",
     rb'(function ID\(\{percentage:(ID),className:(ID)\}\)\{)let ID=ID\(\2\),ID=ID\[ID\];return (ID)\("svg",\{(width:"20",height:"20",viewBox:"0 0 20 20",fill:"none",'
     rb'xmlns:"http://www.w3.org/2000/svg",className:\3,style:\{display:"block"\},children:)\[ID&&(ID)\("path",\{d:ID,stroke:"currentColor",strokeOpacity:"0.15",strokeWidth:"1.5",'
     rb'strokeLinecap:"round"\}\),\6\("path",\{d:ID\[ID\],stroke:"var\(--app-claude-clay-button-orange\)",strokeWidth:"1.5",strokeLinecap:"round"\}\)\]\}\)\}'.replace(b"ID", ID),
     lambda m: (m.group(1) + b"let cbpR=Math.max(0,Math.min(100,+" + m.group(2) + b"||0))/100*2*Math.PI*7.25;return " + m.group(4) + b'("svg",{' + m.group(5).replace(b'width:"20",height:"20"', b'width:"16",height:"16"', 1)
                + b'[' + m.group(6) + b'("circle",{cx:"10",cy:"10",r:"7.25",stroke:"currentColor",strokeOpacity:"0.15",strokeWidth:"1.5"}),cbpR>0&&' + m.group(6)
                + b'("circle",{cx:"10",cy:"10",r:"7.25",stroke:"var(--app-claude-clay-button-orange)",strokeWidth:"1.5",strokeLinecap:"round",strokeDasharray:cbpR+" 100",'
                b'transform:"rotate(-90 10 10)"})]})}')),
    ("pie window",
     rb"contextWindow:(ID)\((ID)\.usageData\.value\.contextWindow,\2\.usageData\.value\.maxOutputTokens\),onCompact:".replace(b"ID", ID),
     lambda m: b"contextWindow:" + m.group(1) + b"(cbpCap(" + m.group(2) + b".usageData.value.contextWindow)," + m.group(2) + b".usageData.value.maxOutputTokens),onCompact:"),
)


def pie_problem(raw, web):
    """Why the pie cannot go in (None when it can): the font tag, or an anchor in the shipped index.js, does not match exactly once (a patched script matches none)."""
    why = css_problem(raw, web, "pie", ())
    for label, pat, _ in PIE_ANCHORS:
        n = len(re.findall(pat, web[1]))
        why = why or (None if n == 1 else "pie anchor %s (%s)" % (label, "no match" if n == 0 else "%d matches" % n))
    return why


PIE_TIP_ANCHORS = (
    ("pie tooltip amounts",
     rb"(\{usedTokens:(ID),contextWindow:(ID),onCompact:ID,buttonClassName:ID\}\)\{[^{}]{0,200}?return ID\(ID,\{percentageUsed:ID,)".replace(b"ID", ID),
     lambda m: m.group(1) + b'cbpTip:Math.round((' + m.group(2) + b'||0)/1e3)+"k/"+Math.round(' + m.group(3) + b'/1e3)+"k",'),
    ("pie tooltip text",
     rb"(\{percentageUsed:ID,onCompact:ID,buttonClassName:ID)(\}\)\{let\[ID,ID\]=ID\(!1\),ID=100-ID;.{0,500}?ID&&ID\(ID,\{text:)"
     rb'`\$\{Math\.round\(ID\)\}% of context remaining until auto-compact\.`,hint:"Click to compact now\."'.replace(b"ID", ID),
     lambda m: m.group(1) + b",cbpTip" + m.group(2) + b"cbpTip"),
)


def pie_web(js):
    for _, pat, rep in PIE_ANCHORS:
        js = re.sub(pat, rep, js)
    if all(len(re.findall(pat, js, re.S)) == 1 for _, pat, _ in PIE_TIP_ANCHORS):
        for _, pat, rep in PIE_TIP_ANCHORS:
            js = re.sub(pat, rep, js, flags=re.S)
    return js


# The folder pill: a small pill after the model name in the composer's footer, in webview/index.js, that names the session's folder: the first line of
# <cwd>/.archive/.folder when that holds a name, else the folder's last part. Shown only in a window with more than one folder; a click renames it. The anchor is the
# model pill (shown unless the footer's fit stage is 2, the narrowest) followed by the model list; the session is read from that list's props. The file, the folder
# count and the rename box live in extension.js (PILL_HANDLER_ANCHOR): the webview asks through the connection the session already has (the way it asks to open an
# url) and gets {name, folders} back, so the pill goes in only when both anchors match. The pill takes the model pill's own look through the page's CSS variables,
# inline, so it needs no stylesheet. The name is text put into the span after the reply, never HTML, and the span has no title and no path.
# The footer resets its fit stage (and lays the footer out again) when a node that is not the model pill is added or removed, and on any text change, and renders again
# on every reset. So the span is always there (never gated on the stage or the folder count; display:none hides it), a reply is asked for once per folder and
# kept (a render that finds it asks for nothing), and the span's text is written only when it differs, into the text node it already has: a render then writes nothing.
# A rename is the only later write, once per rename.
PILL_ANCHOR = (
    rb"(?<![\w$.])(?P<st>ID)!==2&&(?P<jsx>ID)\(ID,\{\.\.\.ID\}\),(?=(?P=jsx)\(ID,\{isOpen:ID\.isOpen,onClose:ID\.onClose,availableModels:(?P<s>ID)\.drawnClaudeConfig\.value\?\.models,)"
    .replace(b"ID", ID)
)
PILL_STYLE = (
    b'{display:"none",cursor:"pointer",flexShrink:1,minWidth:0,maxWidth:"11em",boxSizing:"border-box",padding:"0 8px",borderRadius:9999,fontSize:".85em",lineHeight:"var(--app-pill-min-height)",'
    b'background:"var(--app-pill-background)",color:"var(--app-pill-foreground)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}'
)
# The page side, built once per page: M keeps one entry per folder (the reply, the span that last asked, whether a request is out), put writes a reply into a span
# only where it differs, ask makes the request (null when it failed or came back with no name: the span stays hidden, and a render asks again, up to three times).
PILL_HELPER = (
    b'(globalThis.cbfPill??=(()=>{const M=new Map,'
    b'put=(E,R)=>{if(!E||!R)return;if(R.name&&E.firstChild?.data!==R.name){if(E.firstChild)E.firstChild.data=R.name;else E.append(R.name)}let D=R.folders>1?"":"none";if(E.style.display!==D)E.style.display=D},'
    b'ask=(S,K,N)=>S.getConnection().then((C)=>C.sendRequest({type:"callboard_folder",cwd:K,rename:N})).then((R)=>typeof R?.name=="string"&&R.name?{name:R.name,folders:Number(R.folders)||0}:null,()=>null),'
    b'slot=(K)=>{let X=M.get(K);if(!X)M.set(K,X={});return X};'
    b'return{ref(E,S){if(!E)return;let K=S.cwd.value,X=slot(K);X.el=E;if(X.r)put(E,X.r);else if(!X.p){X.p=1;ask(S,K).then((R)=>{if(R){X.r=R;put(X.el,R)}else X.p=(X.f=(X.f||0)+1)>2})}},'
    b'click(S){let K=S.cwd.value,X=slot(K);ask(S,K,!0).then((R)=>{if(R){X.r=R;put(X.el,R)}})}}})())'
)
# The extension side: a case in front of the one that opens an url, in the switch that answers the webview's requests. It acts only for a cwd that is absolute and is a
# window folder or sits inside one (else it answers the folder's own name and renames nothing), and reads and writes only <cwd>/.archive/.folder.
PILL_HANDLER_ANCHOR = rb'case"open_url":return await this\.openURL\((?P<r>ID)\.request\.url\)'.replace(b"ID", ID)
PILL_HANDLER = (
    b'case"callboard_folder":return{type:"callboard_folder_response",...await(async(cbfQ)=>{let cbfV=require("vscode"),cbfP=require("path"),cbfS=require("fs"),'
    b'cbfW=(cbfV.workspace.workspaceFolders||[]).map((cbfE)=>cbfE.uri.fsPath),cbfC=typeof cbfQ?.cwd=="string"?cbfQ.cwd:"",cbfB=cbfP.basename(cbfC)||cbfC,'
    b'cbfK=cbfP.isAbsolute(cbfC)&&!cbfC.includes("\\0")&&cbfW.some((cbfE)=>{let cbfR=cbfP.relative(cbfE,cbfC);return cbfR!==".."&&!cbfR.startsWith(".."+cbfP.sep)&&!cbfP.isAbsolute(cbfR)}),'
    b'cbfF=cbfP.join(cbfC,".archive",".folder"),cbfN=(cbfT)=>String(cbfT).split(/\\r?\\n/)[0].replace(/[\\u0000-\\u001f\\u007f]/g,"").trim().slice(0,40),'
    b'cbfO=cbfS.constants,cbfM=()=>cbfS.lstatSync(cbfP.dirname(cbfF),{throwIfNoEntry:!1}),cbfG=()=>{if(!cbfK)return cbfB;try{if(!cbfM()?.isDirectory())return cbfB;let cbfD=cbfS.openSync(cbfF,cbfO.O_RDONLY|cbfO.O_NOFOLLOW|cbfO.O_NONBLOCK);try{if(!cbfS.fstatSync(cbfD).isFile())return cbfB;'
    b'let cbfU=Buffer.alloc(256);return cbfN(cbfU.toString("utf8",0,cbfS.readSync(cbfD,cbfU,0,256,0)))||cbfB}finally{cbfS.closeSync(cbfD)}}catch{return cbfB}};'
    b'if(cbfQ?.rename===!0&&cbfK){let cbfA=await cbfV.window.showInputBox({prompt:"Name for this folder\'s pill (empty: the folder\'s own name)",value:cbfG(),'
    b'validateInput:(cbfT)=>cbfT===cbfB?null:/[\\r\\n]/.test(cbfT)?"One line only":cbfT.length>40?"At most 40 characters":null});'
    b'if(cbfA!==void 0){cbfA=cbfA===cbfB?"":cbfN(cbfA);try{let cbfL=cbfM();if(cbfL&&!cbfL.isDirectory())throw 0;'
    b'if(!cbfA){if(cbfL)cbfS.rmSync(cbfF,{force:!0})}else{if(!cbfL)cbfS.mkdirSync(cbfP.dirname(cbfF));let cbfD=cbfS.openSync(cbfF,cbfO.O_WRONLY|cbfO.O_CREAT|cbfO.O_TRUNC|cbfO.O_NOFOLLOW|cbfO.O_NONBLOCK,420);'
    b'try{cbfS.writeSync(cbfD,cbfA+"\\n")}finally{cbfS.closeSync(cbfD)}}}'
    b'catch{cbfV.window.showWarningMessage("Could not save the folder name.")}}}'
    b'return{name:cbfG(),folders:cbfW.length}})(%s.request)};'
)


def pill_problem(raw, web):
    """Why the pill cannot go in (None when it can): an anchor does not match exactly once (the model pill in index.js, the request switch in extension.js), the
    shipped script never reads a session's cwd value or has no connection to ask through, or extension.js already has the handler."""
    for what, pat, text in (("pill anchor", PILL_ANCHOR, web[1]), ("pill handler anchor", PILL_HANDLER_ANCHOR, raw)):
        n = len(re.findall(pat, text))
        if n != 1:
            return "%s (%s)" % (what, "no match" if n == 0 else "%d matches" % n)
    if b"callboard_folder" in raw:
        return "the file already contains callboard_folder"
    miss = [t for t in (b".cwd.value", b".getConnection()", b".sendRequest(") if t not in web[1]]
    return "no " + ", ".join(t.decode() for t in miss) if miss else None


def pill_in(raw):
    return re.sub(PILL_HANDLER_ANCHOR, lambda m: PILL_HANDLER % m.group("r") + m.group(0), raw)


def pill_web(js):
    return re.sub(PILL_ANCHOR, lambda m: m.group(0) + b"typeof " + m.group("s") + b'.cwd?.value=="string"&&' + m.group("s") + b".cwd.value&&(cbfP=>" + m.group("jsx") + b'("span",{style:' + PILL_STYLE
                  + b",ref:(cbfE)=>cbfP.ref(cbfE," + m.group("s") + b"),onClick:()=>cbfP.click(" + m.group("s") + b")}))(" + PILL_HELPER + b"),", js)


# The restore fix: a Claude panel that VS Code restores (or Claude reopens) for a session starts in the window's first folder, where that session is not in the
# list, so it comes back as a new empty session. The saved panel state names no folder, so the fix finds it: the window folder whose project folder holds
# the session's transcript (<config dir>/projects/<folder, every character but a letter or digit as "-">/<session id>.jsonl, the way Claude names it). Three edits:
# a method that does the lookup, setupPanel using it when no folder was given, and the panel serializer passing it the restored session's id. The anchors
# match the file after the folder patch, since they hook into its `cbCwd` argument. Optional: when one misses, none of the three goes in. The lookup answers
# nothing for a one-folder window, an id that is not a UUID, no transcript found (nothing on disk yet, a path over 200 characters, a folder that is a
# sub-folder or worktree) or any error, and the panel then starts in the first folder as it did before.
RESTORE_METHOD = (
    b'cbFolderOf(cbrS){try{if(typeof cbrS!="string"||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cbrS))return;'
    b'let cbrV=require("vscode"),cbrP=require("path"),cbrF=(cbrV.workspace.workspaceFolders||[]).map((cbrE)=>cbrE.uri.fsPath);if(cbrF.length<2)return;'
    b'let cbrD=cbrP.join(process.env.CLAUDE_CONFIG_DIR||cbrP.join(require("os").homedir(),".claude"),"projects");'
    b'return cbrF.find((cbrE)=>require("fs").existsSync(cbrP.join(cbrD,cbrE.replace(/[^a-zA-Z0-9]/g,"-"),cbrS+".jsonl")))}catch{}}'
)
RESTORE_ANCHORS = (
    ("setupPanel", rb"\}(setupPanel\(@,(@),(?:@,){3}@=!1,cbCwd\)\{)".replace(b"@", ID),
     lambda m: b"}" + RESTORE_METHOD + m.group(1) + b"cbCwd??=this.cbFolderOf(" + m.group(2) + b");"),
    ("panel serializer", rb'([A-Za-z_$][\w$]{0,40})\.setupPanel\((@),(@),void 0,(@)\);let (@)=typeof (@)\?\.sessionID==="string"\?\6\.sessionID:\3;'.replace(b"@", ID),
     lambda m: b"let " + m.group(5) + b"=typeof " + m.group(6) + b'?.sessionID==="string"?' + m.group(6) + b".sessionID:" + m.group(3) + b";"
     + m.group(1) + b".setupPanel(" + m.group(2) + b"," + m.group(3) + b",void 0," + m.group(4) + b",void 0,!1," + m.group(1) + b".cbFolderOf(" + m.group(5) + b"));"),
)


def restore_problem(raw, _web):
    """Why the restore fix cannot go in (None when it can): an anchor does not match exactly once, or the file already has the method."""
    for label, pat, _ in RESTORE_ANCHORS:
        n = len(re.findall(pat, raw))
        if n != 1:
            return "restore anchor %s (%s)" % (label, "no match" if n == 0 else "%d matches" % n)
    return "the file already contains cbFolderOf" if b"cbFolderOf" in raw else None


def restore_in(raw):
    for _, pat, rep in RESTORE_ANCHORS:
        raw = re.sub(pat, rep, raw)
    return raw


# The group command's anchor: the registration of the stock command that adds the active tab to a group, which sits inside an `x.subscriptions.push(...)` call
# of the extension's activation. Our registration goes in front of it as one more argument of that push.
GROUPS_ANCHOR = rb'(?P<vs>ID)\.commands\.registerCommand\("claude-vscode\.addSessionTabToGroup",async\(\)=>\{if\(!await (?P<prov>ID)\.addActiveSessionTabToGroup\(\)\)'.replace(b"ID", ID)
GROUPS_COMMAND = "callboard assign group"


def groups_command(m):
    """`callboard assign group` (session id, group name): in the window's group list (the provider's own settings, which are keyed by the window's first folder)
    find the group by name in any letter case, create it when there is none, add the session to it unless it already sits in some group, and save through the
    provider, which also tells the open sidebars. Returns true when the session sits in a group afterwards, false when it was refused: a bad argument, an
    archived session (the provider's save drops archived ids from every group, as the stock command refuses them), or the stock list limits (100 groups,
    1000 sessions: the provider's save would drop the excess without saying). Uses only members the extension keeps unminified."""
    p = m.group("prov")
    return (m.group("vs") + b'.commands.registerCommand("' + GROUPS_COMMAND.encode() + b'",async(cbqS,cbqN)=>{'
            b'if(typeof cbqS!="string"||typeof cbqN!="string"||!cbqN)return!1;let cbqG=' + p + b".settings.getSessionGroups();"
            b"if(" + p + b".settings.getArchivedSessionIds().includes(cbqS))return!1;"
            b"if(cbqG.some((cbqE)=>cbqE.sessionIds.includes(cbqS)))return!0;"
            b"let cbqL=cbqN.toLowerCase(),cbqT=cbqG.find((cbqE)=>cbqE.name.toLowerCase()===cbqL);"
            b"if(!cbqT&&cbqG.length>=100||cbqG.reduce((cbqA,cbqE)=>cbqA+cbqE.sessionIds.length,0)>=1000)return!1;"
            + p + b".persistGroupsFromHost(cbqT?cbqG.map((cbqE)=>cbqE===cbqT?{...cbqE,sessionIds:[...cbqE.sessionIds,cbqS]}:cbqE)"
            b':[...cbqG,{id:require("crypto").randomUUID(),name:cbqN,collapsed:!1,sessionIds:[cbqS]}]);return!0}),' + m.group(0))


def command_problem(raw, command):
    """Why a command at the groups anchor cannot go in (None when it can): the anchor does not match exactly once, or the file already has the command."""
    n = len(re.findall(GROUPS_ANCHOR, raw))
    if n != 1:
        return "groups anchor (%s)" % ("no match" if n == 0 else "%d matches" % n)
    return "the file already contains %s" % command if command.encode() in raw else None


def groups_in(raw):
    return re.sub(GROUPS_ANCHOR, groups_command, raw)


SESSION_COMMAND = "callboard active session"


def session_in(raw):
    """`callboard active session`: the session id of the Claude panel in front, from the provider's own lookup that the stock tab commands use, or undefined."""
    return re.sub(GROUPS_ANCHOR, lambda m: m.group("vs") + b'.commands.registerCommand("' + SESSION_COMMAND.encode() + b'",()=>' + m.group("prov") + b".activePanelSessionId())," + m.group(0), raw)


# The optional pieces, in the order they go in: (marker field, name in messages, why it cannot go in, how it goes in). A piece that cannot go in is left out
# with a warning, and the folder patch still applies.
PIECES = (
    *((f, n, lambda raw, web, f=f, t=t: css_problem(raw, web, f, t), lambda raw, f=f, c=c: css_in(raw, f, globals()[c])) for f, n, c, t in CSS_PIECES),
    ("pie", "context pie", pie_problem, lambda raw: css_in(raw, "pie", PIE_CSS)),
    ("pill", "folder pill", pill_problem, pill_in),  # its page side is in webview/index.js (pill_web)
    ("restore", "restore fix", restore_problem, restore_in),
    ("groups", "group command", lambda raw, _: command_problem(raw, GROUPS_COMMAND), groups_in),
    ("session", "session command", lambda raw, _: command_problem(raw, SESSION_COMMAND), session_in),
)


def pick(sid, opt):
    """The folder a new panel starts in: the caller's {cwd}, else (a fresh open that carries an options object, which is what the + New session buttons send,
    in a window with several folders) the one picked in VS Code's own list, else none. A bare call (the palette, Open, an @-mention) never asks.
    null is a cancelled pick: nothing opens. Uses require("vscode") of the extension's own bundle, so it needs no module alias."""
    return (b'(async()=>{let cbqV=require("vscode"),cbqF=cbqV.workspace.workspaceFolders||[];if(typeof ' + opt + b'?.cwd=="string")return ' + opt + b".cwd;"
            b"if(" + sid + b"!==void 0||!" + opt + b"||cbqF.length<2)return;"
            b"let cbqP=await cbqV.window.showQuickPick(cbqF.map((cbqE)=>({label:cbqE.name,description:cbqE.uri.fsPath,fsPath:cbqE.uri.fsPath}))"
            b',{placeHolder:"Start the session in which folder?"});return cbqP?cbqP.fsPath:null})()')


def refuse(msg):
    print("patch-claude: " + msg, file=sys.stderr)
    sys.exit(1)


def usage(msg):
    print("patch-claude: " + msg, file=sys.stderr)
    sys.exit(2)


def show(p):
    return p if p.isprintable() else json.dumps(p)


def read(path):
    """The bytes of a regular file, never through a link; None when it is missing."""
    if os.path.islink(path):
        refuse("%s is a link; refusing to work through it" % show(path))
    if not os.path.lexists(path):
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            refuse("%s is not a regular file" % show(path))
        return f.read()


def put(path, content, mode):
    """Temp file in the same folder, then a rename over the target: a reader sees the old file or the new one."""
    d, base = os.path.split(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + base + ".callboard-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def version(ext):
    raw = read(os.path.join(ext, "package.json"))
    try:
        pkg = json.loads(raw.decode("utf-8")) if raw is not None else None
    except ValueError:
        pkg = None
    if not isinstance(pkg, dict) or str(pkg.get("publisher")).lower() != "anthropic" or pkg.get("name") != "claude-code":
        refuse("%s is not an installed Claude Code extension folder (its package.json is not anthropic.claude-code)" % show(ext))
    ver = pkg.get("version")
    if not isinstance(ver, str) or not VERSION.fullmatch(ver):
        refuse("the extension's package.json has no version like 1.2.3")
    return ver


def marker_of(ext):
    """The marker's fields, or None when there is none or it is not this script's (the state then reads as leftovers)."""
    raw = read(os.path.join(ext, MARKER))
    try:
        m = json.loads(raw.decode("utf-8")) if raw is not None else None
    except ValueError:
        return None
    ok = isinstance(m, dict) and m.get("patch") == PATCH and all(isinstance(m.get(k), str) for k in ("original_sha256", "patched_sha256"))
    return m if ok else None


def problems(raw):
    """What stops a patch: a label per anchor that matches nothing or more than once. [] means every anchor matches exactly once."""
    out = []
    for used in (NAME, b"cbq"):
        if used in raw:
            out.append("the file already contains %s" % used.decode())
    for label, pat, _ in ANCHORS:
        n = len(re.findall(pat, raw))
        if n != 1:
            out.append("%s (%s)" % (label, "no match" if n == 0 else "%d matches" % n))
    return out


def shipped(ext, *paths):
    """The first of these files (paths inside EXTENSION_DIR) that is a regular file, read never through a link; b"" when none is."""
    if os.path.islink(os.path.join(ext, "webview")):
        return b""
    for p in paths:
        if os.path.isfile(os.path.join(ext, p)) and not os.path.islink(os.path.join(ext, p)):
            return read(os.path.join(ext, p))
    return b""


def webview(ext):
    """The shipped webview's (stylesheet, script): the CSS pieces check their tokens against both, the pie patches the script, which is read from its backup when
    the pie is in. A missing, linked or odd file counts as empty, so those pieces are left out with a warning and the rest still applies."""
    return shipped(ext, "webview/index.css"), shipped(ext, WEB_BACKUP, WEB)


def patched(raw, web):
    """(the patched bytes, {piece: why it is left out, or None when it went in}, the patched webview script or None when the pie is not in). Every anchor is
    replaced on these very bytes and must match exactly once, else nothing is written; the optional pieces are the anchors that may miss, and the CSS pieces
    check their tokens in `web`."""
    for label, pat, rep in ANCHORS:
        raw, n = re.subn(pat, rep, raw)
        if n != 1:
            refuse("%s matched %d times; nothing was changed" % (label, n))
    left = {}
    for field, _, problem, put_in in PIECES:
        left[field] = problem(raw, web)
        if left[field] is None:
            raw = put_in(raw)
    js = pie_web(web[1]) if left["pie"] is None else web[1]
    js = pill_web(js) if left["pill"] is None else js
    return raw, left, None if js == web[1] else js


def warn_left_out(left, tail):
    for field, name, _, _ in PIECES:
        if left[field] is not None:
            print("warning: the %s %s (%s); %s" % (name, tail[0], left[field], tail[1]))


def stale(ext, raw, m):
    """Why the installed patch differs from the one this script builds from the backed-up original, or None when it is the same (or no usable backup is there to build from)."""
    orig = read(os.path.join(ext, BACKUP))
    if orig is None or digest(orig) != m["original_sha256"]:
        return None
    bad = problems(orig)
    if bad:
        return "this script no longer fits the backup: " + "; ".join(bad)
    web = webview(ext)
    if os.path.lexists(os.path.join(ext, WEB_BACKUP)) and digest(web[1]) != m.get("web_original_sha256"):
        return "%s does not match the marker's recorded original" % WEB_BACKUP
    new, left, new_js = patched(orig, web)
    if digest(new) == digest(raw) and (web[1] if new_js is None else new_js) == shipped(ext, WEB):
        return None
    for field, name, _, _ in PIECES:
        if left[field] is None and m.get(field) is not True:
            return "the %s is not in" % name
    return "the patch code differs from this script's"


def state(ext):
    """(name, version, detail). Reads only."""
    ver = version(ext)
    raw = read(os.path.join(ext, MAIN))
    if raw is None:
        refuse("%s has no %s" % (show(ext), MAIN))
    m = marker_of(ext)
    # The webview script is as the marker says: patched (its hash named) with its backup beside it, or not touched and with no backup.
    web = m is not None and os.path.lexists(os.path.join(ext, WEB_BACKUP)) == ("web_patched_sha256" in m) and ("web_patched_sha256" not in m or m["web_patched_sha256"] == digest(shipped(ext, WEB)))
    if m is not None and m["patched_sha256"] == digest(raw) and web:
        why = stale(ext, raw, m)
        return ("outdated", ver, why) if why else ("patched", ver, "")
    left = [n for n in (MARKER, BACKUP, WEB_BACKUP) if os.path.lexists(os.path.join(ext, n))]
    if left:
        return "leftovers", ver, ", ".join(left)
    bad = problems(raw)
    return ("anchors-missing", ver, "; ".join(bad)) if bad else ("unpatched-patchable", ver, "")


def reason(e):
    return e.strerror if isinstance(e, OSError) and e.strerror else type(e).__name__


def set_web(ext, orig, new):
    """Bring webview/index.js to `new`, which is `orig` (the shipped script) or the pie's patch of it; the shipped one stays beside it as WEB_BACKUP while they differ."""
    path, backup = os.path.join(ext, WEB), os.path.join(ext, WEB_BACKUP)
    if new != orig and not os.path.lexists(backup):
        os.link(path, backup)
    if shipped(ext, WEB) != new:
        put(path, new, os.stat(path).st_mode & 0o777)
        if shipped(ext, WEB) != new:
            raise OSError("the file read back differs")
    if new == orig and os.path.lexists(backup):
        os.unlink(backup)


def web_touched(ext, new_js):
    """Whether a write has to bring webview/index.js to a state: the pie goes in, or an earlier patch of it is in (its backup is there)."""
    return new_js is not None or os.path.lexists(os.path.join(ext, WEB_BACKUP))


def write_patch(ext, ver, orig, new, left, orig_js, new_js):
    """The one write of a patch, for --apply and --update: the webview script when the pie is in (or goes out), the patched file, read back, then the marker that vouches for them."""
    if web_touched(ext, new_js):
        set_web(ext, orig_js, orig_js if new_js is None else new_js)
    main = os.path.join(ext, MAIN)
    put(main, new, os.stat(main).st_mode & 0o777)
    if read(main) != new:
        raise OSError("the file read back differs")
    web = {} if new_js is None else {"web_original_sha256": digest(orig_js), "web_patched_sha256": digest(new_js)}
    put(os.path.join(ext, MARKER), json.dumps({"patch": PATCH, "version": ver, **{f: left[f] is None for f, _, _, _ in PIECES}, "original_sha256": digest(orig), "patched_sha256": digest(new), **web}).encode() + b"\n", 0o644)


def apply(ext):
    name, ver, detail = state(ext)
    if name == "patched":
        print("already patched %s" % ver)
        return 0
    if name == "outdated":
        refuse("the patch in %s is outdated (%s); run --update" % (show(ext), detail))
    if name == "leftovers":
        refuse("%s from an earlier run is in %s but does not match the file; run --undo first" % (detail, show(ext)))
    if name == "anchors-missing":
        print("anchors-missing %s: %s" % (ver, detail))
        print("Nothing was changed. The extension's code moved; the patterns in this script need a repair.")
        return 1
    main = os.path.join(ext, MAIN)
    raw = read(main)
    web = webview(ext)
    new, left, new_js = patched(raw, web)
    backup = os.path.join(ext, BACKUP)
    try:
        # A hard link costs no space, and the patched file is a new inode, so the backup keeps the original.
        os.link(main, backup)
        write_patch(ext, ver, raw, new, left, web[1], new_js)
    except BaseException as e:
        # Back to the original: renaming the backup over the file is atomic and needs no space (a no-op when both are still one inode).
        for b, f in ((BACKUP, MAIN), (WEB_BACKUP, WEB)):
            if os.path.lexists(os.path.join(ext, b)):
                os.replace(os.path.join(ext, b), os.path.join(ext, f))
        for n in (BACKUP, WEB_BACKUP, MARKER):
            if os.path.lexists(os.path.join(ext, n)):
                os.unlink(os.path.join(ext, n))
        refuse("could not patch (%s); the original is back and nothing is left over" % reason(e))
    print("patched %s" % ver)
    print("Changed: %s (backup: %s, marker: %s, all in %s)" % (MAIN, BACKUP, MARKER, show(ext)))
    warn_left_out(left, ("is not in", "the folder patch is."))
    print("Reload the VS Code window (Developer: Reload Window) to load it. Undo: run this with --undo.")
    return 0


def update(ext):
    name, ver, detail = state(ext)
    if name != "outdated":
        return apply(ext)
    main = os.path.join(ext, MAIN)
    orig = read(os.path.join(ext, BACKUP))
    bad = problems(orig)
    if bad:
        refuse("this script cannot build the patch from the backup (%s); nothing was changed" % "; ".join(bad))
    web = webview(ext)
    if "does not match" in detail:
        refuse("%s; nothing was changed. Run --undo, or reinstall the extension" % detail)
    new, left, new_js = patched(orig, web)
    # The previous patched file stays reachable under a second name (a hard link, no space) until the new one is in: a failed write puts it back.
    prev = os.path.join(ext, PREVIOUS)
    if os.path.lexists(prev):
        os.unlink(prev)
    os.link(main, prev)
    before_js = shipped(ext, WEB)
    wb = os.path.join(ext, WEB_BACKUP)
    made = new_js is not None and not os.path.lexists(wb)
    touched = web_touched(ext, new_js)
    failed = stuck = None
    try:
        write_patch(ext, ver, orig, new, left, web[1], new_js)
    except BaseException as e:
        # A no-op when the file was never replaced (both names are one inode), so the spare name goes either way. The webview script goes back to what it was: a
        # backup this run made is renamed over it (atomic, needs no space, as in --apply), else the earlier patch of it is written back.
        os.replace(prev, main)
        if made:
            if os.path.lexists(wb):
                os.replace(wb, os.path.join(ext, WEB))
            if os.path.lexists(wb):
                os.unlink(wb)
        elif touched:
            try:
                set_web(ext, web[1], before_js)
            except Exception as e2:
                stuck = e2
        failed = e
    if os.path.lexists(prev):
        os.unlink(prev)
    if stuck is not None:
        # The backups are untouched, so --undo puts both files back.
        refuse("could not update (%s) and %s could not be put back (%s); the two files are from different builds; free some space, then run --undo" % (reason(failed), WEB, reason(stuck)))
    if failed is not None:
        refuse("could not update (%s); the previous patch is back and nothing else changed" % reason(failed))
    print("updated %s" % ver)
    print("Changed: %s and %s, rebuilt from the backup %s (not touched), all in %s" % (MAIN, MARKER, BACKUP, show(ext)))
    warn_left_out(left, ("is not in", "the folder patch is."))
    print("Reload the VS Code window (Developer: Reload Window) to load it. Undo: run this with --undo.")
    return 0


def undo(ext):
    version(ext)
    main = os.path.join(ext, MAIN)
    m = marker_of(ext)
    orig = read(os.path.join(ext, BACKUP))
    orig_js = read(os.path.join(ext, WEB_BACKUP))
    if orig is None and orig_js is None and not os.path.lexists(os.path.join(ext, MARKER)):
        print("nothing to undo")
        return 0
    js = shipped(ext, WEB)
    for name, backup, field in ((BACKUP, orig, "original_sha256"), (WEB_BACKUP, orig_js, "web_original_sha256")):
        if backup is None or m is None or digest(backup) == m.get(field):
            continue
        # An --update of an install made before the marker held web hashes can stop after the pie went in and before the new marker: the backup is the original
        # then, shown by the script now being it, or any of the pieces built from it.
        if field == "web_original_sha256" and field not in m and js in (backup, pie_web(backup), pill_web(backup), pill_web(pie_web(backup))):
            continue
        refuse("%s does not match the marker's recorded original; left alone. Reinstall the extension instead" % name)
    raw = read(main)
    if orig_js is None and m is not None and "web_patched_sha256" in m and digest(shipped(ext, WEB)) != m["web_original_sha256"]:
        refuse("the backup of %s is gone and it is not known to be the original; reinstall the extension instead" % WEB)
    if orig is None:
        if m is None or raw is None or digest(raw) != m["original_sha256"]:
            refuse("the backup is gone and %s is not known to be the original; reinstall the extension instead" % MAIN)
    elif raw != orig:
        put(main, orig, os.stat(main).st_mode & 0o777)
    if orig_js is not None and shipped(ext, WEB) != orig_js:
        put(os.path.join(ext, WEB), orig_js, os.stat(os.path.join(ext, WEB)).st_mode & 0o777)
    for n in (BACKUP, WEB_BACKUP, MARKER, PREVIOUS):
        if os.path.lexists(os.path.join(ext, n)):
            os.unlink(os.path.join(ext, n))
    print("undone: the original %s is back, backups and marker removed" % MAIN)
    print("Reload the VS Code window to load it.")
    return 0


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = [a for a in argv if a.startswith("--")]
    if len(args) != 1 or any(f not in ("--apply", "--update", "--undo") for f in flags) or len(flags) > 1:
        usage("usage: patch-claude.py EXTENSION_DIR [--apply | --update | --undo]")
    if os.geteuid() == 0:
        refuse("run this as your user, not as root")
    ext = os.path.abspath(args[0])
    if os.path.islink(ext) or not os.path.isdir(ext):
        refuse("%s is not a folder (a link is refused too)" % show(ext))
    if flags == ["--apply"]:
        return apply(ext)
    if flags == ["--update"]:
        return update(ext)
    if flags == ["--undo"]:
        return undo(ext)
    name, ver, detail = state(ext)
    print("%s %s%s" % (name, ver, ": " + detail if detail else ""))
    if name == "unpatched-patchable":
        warn_left_out(patched(read(os.path.join(ext, MAIN)), webview(ext))[1], ("would be left out", "the folder patch would still apply."))
    if name == "patched":
        for field, piece, _, _ in PIECES:
            if marker_of(ext).get(field) is not True:
                print("warning: the %s is not in this patch." % piece)
    if name == "leftovers":
        print("A backup or marker from an earlier run is here and does not match the file: run --undo.")
    if name == "outdated":
        print("Run --update: it rebuilds the patch from the backup and swaps it in.")
    return 1 if name in ("anchors-missing", "leftovers", "outdated") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
