import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { runningSubagents, completedSubagentResults } from "../runtime/state.ts";
import { getEffectiveAgentDefinitions, loadAgentDefaults, type AgentDefaults } from "../agents/definitions.ts";
import { readSubagentLaunchMetadata, type PersistedSubagentLaunchMetadata } from "../session/session-files.ts";
import { resumeSubagentSession, type ResumeServiceRuntime } from "../runtime/resume-service.ts";
import { stopRunningSubagent } from "../runtime/wiring.ts";
import { getEntries, findLastAssistantMessage } from "../session/session.ts";

export interface SubagentsViewRuntime extends ResumeServiceRuntime {
	pi: ExtensionAPI;
	wireSubagentSteerBack: (pi: ExtensionAPI, r: import("../types.ts").RunningSubagent, p: Promise<import("../types.ts").SubagentResult>) => void;
}

type TabIndex = 0 | 1 | 2;
const TABS = [{ label: "Running" }, { label: "Completed" }, { label: "Agents" }];

interface OverlayTheme {
	fg(tone: string, text: string): string;
	bold(text: string): string;
}

interface Item {
	id: string;
	icon: string;
	name: string;
	agent?: string;
	stats: string[];
	preview: string;
	detailSections: Array<{ title: string; fields: Array<{ label: string; value: string }> }>;
	canKill: boolean;
	canMessage: boolean;
	onKill?: () => Promise<void>;
	onMessage?: (ctx: ExtensionContext) => Promise<void>;
}

function formatElapsed(ms: number): string { const s = (Date.now()-ms)/1000; return s<60 ? `${s.toFixed(1)}s` : `${Math.floor(s/60)}m${Math.floor(s%60)}s`; }
function formatElapsedStatic(sec: number): string { return sec<60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec/60)}m${Math.floor(sec%60)}s`; }
function compactCount(n: number): string { return n>=1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n>=1_000 ? `${(n/1_000).toFixed(1)}K` : `${n}`; }
function firstLine(text: string, max=60): string { const l = text.split("\n").map(v=>v.trim()).find(Boolean)??""; return l.length>max ? `${l.slice(0,max)}…` : l; }

function fmt(l: string, v: string | undefined | null): string { return `  ${l.padEnd(22)} ${(v??"—").padEnd(28)}`; }

const CAT_LABELS = ["── Identity ──","── Launch ──","── Capabilities ──","── Lifecycle ──"];
const CAT_ORDER = ["name","description","agent file","launched","model","thinking","mode","cwd","flags","tools","deny-tools","extensions","skills","spawning","no-context-files","async","auto-exit","session-mode","parent-close","no-session","timeout","fork-output-reserve"];
const CAT_STARTS = [0,4,9,15];

function buildSections(defs: AgentDefaults|null, meta?: PersistedSubagentLaunchMetadata): Array<{title: string; fields: Array<{label:string;value:string}>}> {
	const fields: Array<{label:string;value:string}> = [];
	const ad = defs as any;
	fields.push({label:"name",value:meta?.name??ad?.name??"—"});
	fields.push({label:"description",value:ad?.description??"—"});
	fields.push({label:"agent file",value:ad?.path??"—"});
	if(meta) fields.push({label:"launched",value:meta.timestamp?new Date(meta.timestamp).toLocaleString():"—"});
	fields.push({label:"model",value:meta?.model??defs?.model??"—"});
	fields.push({label:"thinking",value:meta?.thinking??defs?.thinking??"—"});
	fields.push({label:"mode",value:meta?.mode??defs?.mode??"—"});
	fields.push({label:"cwd",value:meta?.cwd??defs?.cwd??"—"});
	fields.push({label:"flags",value:meta?.flags??defs?.flags??"—"});
	fields.push({label:"tools",value:meta?.tools??defs?.tools??"all"});
	fields.push({label:"deny-tools",value:defs?.denyTools??"—"});
	fields.push({label:"extensions",value:meta?.extensions?.length?meta.extensions.join(", "):"all"});
	fields.push({label:"skills",value:meta?.skills??defs?.skills??"—"});
	fields.push({label:"spawning",value:(defs?.spawning??false).toString()});
	fields.push({label:"no-context-files",value:(meta?meta.noContextFiles:(defs?.noContextFiles??false)).toString()});
	fields.push({label:"async",value:(meta?meta.async:(defs?.async??true)).toString()});
	fields.push({label:"auto-exit",value:(meta?(meta.autoExit??false):(defs?.autoExit??false)).toString()});
	fields.push({label:"session-mode",value:meta?.sessionMode??defs?.sessionMode??"lineage-only"});
	fields.push({label:"parent-close",value:meta?.parentClosePolicy??defs?.parentClosePolicy??"terminate"});
	fields.push({label:"no-session",value:(meta?meta.noSession:(defs?.noSession??false)).toString()});
	fields.push({label:"timeout",value:defs?.timeout!=null?`${defs.timeout}s`:"—"});
	fields.push({label:"fork-output-reserve",value:meta?.forkOutputReserveTokens!=null?`${meta.forkOutputReserveTokens}`:defs?.forkOutputReserveTokens!=null?`${defs.forkOutputReserveTokens}`:"10000"});
	const sections: Array<{title:string;fields:Array<{label:string;value:string}>}> = [];
	let curCat=-1;
	for(const lbl of CAT_ORDER){
		const fi=fields.findIndex(f=>f.label===lbl); if(fi<0) continue;
		const ci=CAT_STARTS.filter(s=>s<=fi).length-1;
		if(ci>=0&&ci!==curCat){curCat=ci; sections.push({title:CAT_LABELS[Math.min(ci,CAT_LABELS.length-1)]??"",fields:[]});}
		sections[sections.length-1].fields.push(fields[fi]);
	}
	return sections;
}

function buildRuntimeSection(isRunning: boolean, r: any): {title:string;fields:Array<{label:string;value:string}>} {
	const fields: Array<{label:string;value:string}> = [];
	if(isRunning&&r.startTime) fields.push({label:"elapsed",value:formatElapsed(r.startTime)});
	else if(r.elapsed!=null) fields.push({label:"elapsed",value:`${r.elapsed}s`});
	if(r.messageCount!=null) fields.push({label:"messages",value:`${r.messageCount}`});
	if(r.toolUses!=null) fields.push({label:"tool uses",value:`${r.toolUses}`});
	const used=r.totalTokens??0;
	const ctxW=r.modelContextWindow;
	if(used>0&&ctxW) fields.push({label:"context",value:`${compactCount(used)}/${compactCount(ctxW)}`});
	else if(r.contextLabel) fields.push({label:"context",value:r.contextLabel});
	else if(used>0) fields.push({label:"tokens",value:compactCount(used)});
	if(r.activity) fields.push({label:"activity",value:r.activity});
	if(r.sessionFile) fields.push({label:"session",value:r.sessionFile});
	if(r.surface) fields.push({label:"pane",value:r.surface});
	if(r.childProcess?.pid) fields.push({label:"PID",value:`${r.childProcess.pid}`});
	return {title:"── Runtime ──",fields};
}

function safeMeta(f: string): PersistedSubagentLaunchMetadata|undefined { try{return readSubagentLaunchMetadata(f)}catch{return} }
function safeDefs(a: string,c: string): AgentDefaults|null { try{return loadAgentDefaults(a,undefined,c,(h,b)=>b)}catch{return null} }
function buildStats(a: {toolUses?:number;totalTokens?:number;modelContextWindow?:number;contextLabel?:string;startTime:number}): string[] {
	const s:string[]=[];
	if(a.toolUses) s.push(`${a.toolUses} tool use${a.toolUses===1?"":"s"}`);
	const u=a.totalTokens??0;
	if(u>0&&a.modelContextWindow) s.push(`${compactCount(u)}/${compactCount(a.modelContextWindow)} ctx`);
	else if(a.contextLabel) s.push(a.contextLabel);
	else if(u>0) s.push(`${compactCount(u)} tokens`);
	s.push(formatElapsed(a.startTime));
	return s;
}

function buildItems(ctx: ExtensionContext): Item[] {
	const items: Item[] = [];
	for(const a of runningSubagents.values()){
		const meta=safeMeta(a.sessionFile); const defs=a.agent?safeDefs(a.agent,ctx.cwd):null;
		const sections=buildSections(defs,meta); sections.push(buildRuntimeSection(true,a));
		const label=a.agent&&a.agent!==a.name?`${a.name} (${a.agent})`:a.name;
		items.push({
			id:a.id, icon:"●", name:label, agent:a.agent, stats:buildStats(a),
			preview:a.activity??a.taskPreview??"starting…",
			detailSections:sections, canKill:true, canMessage:false,
			onKill:async()=>{const ok=await ctx.ui.confirm("Kill subagent?",`Stop "${a.name}"?`); if(!ok)return; stopRunningSubagent(a); ctx.ui.notify(`Stopped ${a.name}`,"info");},
		});
	}
	return items;
}

async function buildCompleted(ctx: ExtensionContext): Promise<Item[]> {
	const items:Item[]=[]; const seen=new Set<string>();
	for(const [id,r] of completedSubagentResults){
		seen.add(r.sessionFile??id);
		const icon=r.status==="completed"?"✓":r.status==="cancelled"?"⚡":"✗";
		const summary=r.errorMessage?`error: ${firstLine(r.errorMessage,40)}`:r.summary?firstLine(r.summary,40):`exit ${r.exitCode}`;
		const meta=r.sessionFile?safeMeta(r.sessionFile):undefined; const defs=r.agent?safeDefs(r.agent,ctx.cwd):null;
		const sections=buildSections(defs,meta); sections.push(buildRuntimeSection(false,r));
		items.push({id:r.id,icon,name:r.name,stats:[formatElapsedStatic(r.elapsed)],preview:summary,detailSections:sections,canKill:false,canMessage:true,
			onMessage:async(c2)=>{await doResume(c2,r.sessionFile,r.name,r.agent,r.id);}});
	}
	const sf=ctx.sessionManager.getSessionFile?.();
	if(sf) try{
		const entries=getEntries(sf)as Array<Record<string,unknown>>;
		for(const e of entries){if(e?.type!=="message"||(e.message as any)?.role!=="toolResult")continue;
			const d=(e.message as any)?.details; if(!d)continue;
			const files:string[]=[]; if(typeof d.sessionFile==="string")files.push(d.sessionFile);
			const ch=d.children as any[]|undefined; if(Array.isArray(ch)) for(const c of ch){if(typeof c.sessionFile==="string")files.push(c.sessionFile);}
			for(const f of files){if(seen.has(f))continue; seen.add(f);
				const m=safeMeta(f); if(!m)continue;
				const n=m.name??(d.name as string)??"unknown";
				let prev="(previous session)"; try{const ce=getEntries(f);const lm=findLastAssistantMessage(ce as any);if(lm){const t=firstLine(lm,50);if(t)prev=t;}}catch{}
				items.push({id:`orphan-${f.replace(/[/\\]/g,"_")}`,icon:"?",name:n,stats:[],preview:prev,detailSections:buildSections(m.agent?safeDefs(m.agent,ctx.cwd):null,m),canKill:false,canMessage:true,onMessage:async(c2)=>{await doResume(c2,f,n,m.agent);}});
			}
		}
	}catch{}
	return items;
}

let _rt: SubagentsViewRuntime|null = null;
async function doResume(ctx:ExtensionContext,sf:string|undefined,name:string,agent?:string,cid?:string){
	if(!sf){ctx.ui.notify("No session file.","error");return;}
	const msg=await ctx.ui.input("Follow-up:","Message to resume this subagent…");
	if(!msg||!msg.trim())return;
	try{const r=await resumeSubagentSession({sessionFile:sf,task:msg.trim(),name,agent},_rt!); _rt!.wireSubagentSteerBack(_rt!.pi,r,r.completionPromise!); if(cid)completedSubagentResults.delete(cid); ctx.ui.notify(`Resumed ${name}.`,"info");}
	catch(err){ctx.ui.notify(`Failed: ${err instanceof Error?err.message:String(err)}`,"error");}
}

function agentDefs(): Item[] {
	return getEffectiveAgentDefinitions().map((d)=>({
		id:d.name,icon:"",name:d.name,stats:[],preview:d.description?firstLine(d.description,60):"",
		detailSections:buildAgentDetail(d),canKill:false,canMessage:false,
	}));
}

function buildAgentDetail(d:any): Array<{title:string;fields:Array<{label:string;value:string}>}> {
	const s=buildSections(d,undefined);
	if(d.body){s.push({title:"── Agent Body ──",fields:d.body.split("\n").filter((l:string)=>l.trim()).map((l:string)=>({label:"",value:l}))});}
	return s;
}

export class SubagentsOverlay implements Component {
	private tab=0; private sel=0; private detail=-1; private scroll=0;
	private items:Item[]=[]; private w?:number; private cl?:string[];
	private timer:ReturnType<typeof setInterval>|null=null; private cp:Promise<void>|null=null;
	private ctx:ExtensionContext; private done:(r:null)=>void; private th:OverlayTheme;

	constructor(done:(r:null)=>void,ctx:ExtensionContext,th:OverlayTheme){
		this.done=done; this.ctx=ctx; this.th=th; _rt?.startWidgetRefresh();
		this.refresh(); this.timer=setInterval(()=>{this.refresh();},2000);
	}
	dispose(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
	close(){this.dispose();this.done(null);}
	private refresh(){
		if(this.tab===0) this.items=buildItems(this.ctx);
		else if(this.tab===2) this.items=agentDefs();
		this.sel=Math.min(this.sel,Math.max(0,this.items.length-1)); this.invalidate();
	}
	private ensureC(){
		if(this.tab!==1||this.cp)return;
		this.items=[{id:"loading",icon:"…",name:"Loading…",stats:[],preview:"",detailSections:[],canKill:false,canMessage:false}];
		this.cp=buildCompleted(this.ctx).then((items)=>{this.items=items;this.sel=Math.min(this.sel,Math.max(0,this.items.length-1));this.invalidate();});
	}
	handleInput(d:string){
		if(matchesKey(d,Key.alt("s"))){this.close();return;}
		if(matchesKey(d,Key.escape)){if(this.detail>=0){this.detail=-1;this.scroll=0;this.invalidate();}else{this.close();}return;}
		if(this.detail>=0){
			if(matchesKey(d,Key.down)||matchesKey(d,"j")){const m=Math.max(0,(this.items[this.detail]?.detailSections.reduce((a,s)=>a+s.fields.length+2,0)??0)-25);if(this.scroll<m){this.scroll++;this.invalidate();}return;}
			if((matchesKey(d,Key.up)||matchesKey(d,"k"))&&this.scroll>0){this.scroll--;this.invalidate();return;}
			return;
		}
		if(matchesKey(d,Key.left)&&this.tab>0){this.tab=(this.tab-1)as TabIndex;this.sel=0;this.cp=null;this.refresh();if(this.tab===1)this.ensureC();return;}
		if(matchesKey(d,Key.right)&&this.tab<2){this.tab=(this.tab+1)as TabIndex;this.sel=0;this.cp=null;this.refresh();if(this.tab===1)this.ensureC();return;}
		if(matchesKey(d,Key.up)&&this.sel>0){this.sel--;this.invalidate();return;}
		if(matchesKey(d,Key.down)&&this.sel<this.items.length-1){this.sel++;this.invalidate();return;}
		const it=this.items[this.sel];if(!it)return;
		if(matchesKey(d,"i")||matchesKey(d,Key.enter)){if(it.detailSections.length>0||it.preview){this.detail=this.sel;this.scroll=0;this.invalidate();}return;}
		if(matchesKey(d,"k")&&it.canKill&&it.onKill){it.onKill().then(()=>this.refresh());return;}
		if(matchesKey(d,"m")&&it.canMessage&&it.onMessage){it.onMessage(this.ctx).then(()=>this.refresh());return;}
	}
	render(w:number):string[]{
		if(this.tab===1)this.ensureC();
		const lines:string[]=[]; const add=(l="")=>lines.push(truncateToWidth(l,w));
		const th=this.th; const t=this.tab;
		// Header
		add(th.fg("accent","─".repeat(Math.min(w,60))));
		add(TABS.map((x,i)=>i===t?th.bold(`[${x.label}]`):th.fg("dim",` ${x.label} `)).join("  "));
		add(th.fg("accent","─".repeat(Math.min(w,60))));
		// Body
		if(this.detail>=0){this.renderDetail(add,w);}
		else if(this.items.length===0){add(`  ${th.fg("muted",t===0?"No running subagents.":t===1?"No completed subagents.":"No agent definitions found.")}`);}
		else{this.renderList(add,w);}
		// Footer
		add("");
		const hints=t===0?["↑↓ navigate","←→ tabs","k kill","i info","Esc close"]:
			t===1?["↑↓ navigate","←→ tabs","m message","i info","Esc close"]:
			["↑↓ navigate","←→ tabs","i info","Esc close"];
		add(th.fg("dim",truncateToWidth(hints.join("  "),w)));
		this.w=w;this.cl=lines;return lines;
	}
	private renderList(add:(s:string)=>void,w:number){
		const th=this.th;
		for(let i=0;i<this.items.length;i++){
			const it=this.items[i]!; const sel=i===this.sel;
			const conn=i===this.items.length-1?"└─":"├─"; const child=i===this.items.length-1?"   ":"│  ";
			const spin=th.fg("accent",it.icon?`${it.icon}`:" ")+(it.icon?" ":"  ");
			const name=sel?th.bold(th.fg("accent",it.name)):th.bold(it.name);
			const badge=it.agent?th.fg("muted",` (${it.agent})`):"";
			const stats=it.stats.length?` ${th.fg("dim","·")} ${th.fg("dim",it.stats.join(" · "))}`:"";
			add(`${th.fg("dim",conn)} ${spin}${name}${badge}${stats}`);
			if(it.preview) add(`${th.fg("dim",child)}${th.fg("muted",`  ${it.preview}`)}`);
		}
	}
	private renderDetail(add:(s:string)=>void,w:number){
		const it=this.items[this.detail]; if(!it)return;
		const th=this.th;
		add(th.fg("accent","▸")+" "+th.bold(th.fg("accent",it.name)));
		if(it.agent) add(th.fg("muted",`  (${it.agent})`));
		add(th.fg("dim","─".repeat(Math.min(w,60))));
		let rem=25; let sk=this.scroll;
		for(const sec of it.detailSections){
			if(sk>0&&rem<=0)break;
			let needsSec=sec.fields.length>0&&sec.fields.some(f=>f.label);
			if(!needsSec)continue;
			const secLines=[sec.title,...sec.fields.map(f=>fmt(f.label,f.value))];
			const visible=secLines.filter(()=>{if(sk>0){sk--;return false;}if(rem<=0)return false;rem--;return true;});
			for(const l of visible)add(l);
		}
		add(""); add(th.fg("dim","↑↓/jk scroll · Esc back · alt+s close"));
	}
	invalidate(){this.w=undefined;this.cl=undefined;}
}

export function registerSubagentsView(pi:ExtensionAPI,runtime:SubagentsViewRuntime){
	_rt=runtime; let ao:SubagentsOverlay|null=null;
	function open(ctx:ExtensionContext){
		if(ao)return;
		if(!runningSubagents.size&&!completedSubagentResults.size&&!getEffectiveAgentDefinitions().length){ctx.ui.notify("No subagents/definitions.","info");return;}
		ctx.ui.custom<null>((_tui,theme,_kb,done)=>{const o=new SubagentsOverlay(done,ctx,{fg:(tone,t)=>theme.fg(tone as any,t),bold:(t)=>theme.bold(t)});ao=o;return o;},{overlay:true})
			.then(()=>{ao=null;}).catch(()=>{ao=null;});
	}
	pi.registerCommand("subagents",{description:"Open subagent manager",handler:async(_a,c)=>{open(c);}});
	pi.registerShortcut?.("alt+s",{description:"Toggle subagent manager",handler:async(c)=>{if(ao){ao.close();ao=null;return;}open(c);}});
	pi.on("session_shutdown",async()=>{if(ao){ao.dispose();ao=null;}});
}
