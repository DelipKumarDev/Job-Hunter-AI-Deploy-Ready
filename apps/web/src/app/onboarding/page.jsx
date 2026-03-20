// ══════════════════════════════════════════════════════════════
// Job Hunter AI — Onboarding Wizard
// 5-step flow: Welcome → Resume → Preferences → Email → Launch
// ══════════════════════════════════════════════════════════════
"use client";
import { useState, useCallback } from "react";

const C = {
  bg:"#050608",s1:"#0a0c10",s2:"#0f1218",s3:"#141820",
  b1:"#1c2333",b2:"#232d40",
  t1:"#edf2ff",t2:"#8898b8",t3:"#4a5878",
  acid:"#00ff88",blue:"#3b82f6",amber:"#f59e0b",
  red:"#f43f5e",violet:"#8b5cf6",cyan:"#06b6d4",
};

const STEPS = [
  { id:"welcome",    label:"Welcome",     icon:"👋" },
  { id:"resume",     label:"Resume",      icon:"📄" },
  { id:"prefs",      label:"Preferences", icon:"🎯" },
  { id:"email",      label:"Email",       icon:"✉️" },
  { id:"launch",     label:"Launch",      icon:"🚀" },
];

// ── Tag input ─────────────────────────────────────────────────
function TagInput({ tags, onAdd, onRemove, placeholder, color = C.acid }) {
  const [input, setInput] = useState("");
  const add = () => {
    const v = input.trim();
    if (v && !tags.includes(v)) { onAdd(v); setInput(""); }
  };
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:8, padding:"10px 12px", background:C.s3, border:`1px solid ${C.b2}`, borderRadius:8, minHeight:48, alignItems:"center" }}>
      {tags.map(t => (
        <span key={t} style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"3px 10px", borderRadius:6, background:`${color}15`, border:`1px solid ${color}30`, fontSize:12, color, fontFamily:"var(--mono)" }}>
          {t}
          <button onClick={() => onRemove(t)} style={{ background:"none", border:"none", color, cursor:"pointer", fontSize:14, lineHeight:1, padding:0 }}>×</button>
        </span>
      ))}
      <input
        value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => (e.key==="Enter"||e.key===",") && (e.preventDefault(), add())}
        placeholder={placeholder}
        style={{ border:"none", background:"none", outline:"none", color:C.t1, fontSize:13, flex:1, minWidth:120 }}
      />
    </div>
  );
}

// ── Toggle switch ─────────────────────────────────────────────
function Toggle({ on, onChange, label, sub }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 0", borderBottom:`1px solid ${C.b1}` }}>
      <div>
        <div style={{ fontSize:14, color:C.t1, fontWeight:500 }}>{label}</div>
        {sub && <div style={{ fontSize:12, color:C.t3, marginTop:3 }}>{sub}</div>}
      </div>
      <div onClick={() => onChange(!on)} style={{ width:44, height:24, borderRadius:12, background: on ? C.acid : C.b2, cursor:"pointer", position:"relative", transition:"background .2s", flexShrink:0 }}>
        <div style={{ position:"absolute", top:3, left: on ? 23 : 3, width:18, height:18, borderRadius:"50%", background: on ? "#000" : C.t3, transition:"left .2s" }} />
      </div>
    </div>
  );
}

// ── File drop zone ────────────────────────────────────────────
function DropZone({ file, onFile }) {
  const [dragging, setDragging] = useState(false);
  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }, [onFile]);
  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{
        border:`2px dashed ${dragging ? C.acid : file ? C.acid+"60" : C.b2}`,
        borderRadius:12, padding:"48px 32px", textAlign:"center", cursor:"pointer",
        background: dragging ? `${C.acid}06` : file ? `${C.acid}04` : C.s3,
        transition:"all .2s",
      }}
      onClick={() => document.getElementById("resume-file").click()}
    >
      <input id="resume-file" type="file" accept=".pdf,.doc,.docx" hidden onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
      {file ? (
        <>
          <div style={{ fontSize:40, marginBottom:12 }}>✅</div>
          <div style={{ fontSize:15, fontWeight:700, color:C.acid }}>{file.name}</div>
          <div style={{ fontSize:12, color:C.t3, marginTop:6 }}>{(file.size/1024).toFixed(0)} KB · Click to replace</div>
        </>
      ) : (
        <>
          <div style={{ fontSize:40, marginBottom:12 }}>📄</div>
          <div style={{ fontSize:15, fontWeight:600, color:C.t1, marginBottom:6 }}>Drop your resume here</div>
          <div style={{ fontSize:13, color:C.t3 }}>PDF, DOC, DOCX · Max 10MB</div>
        </>
      )}
    </div>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [resumeFile, setResumeFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [prefs, setPrefs] = useState({
    roles: [], locations: [], minSalary: 80000, maxSalary: 200000,
    remote: true, hybrid: true, onsite: false,
    seniorities: ["mid","senior"],
    autoApply: true, matchThreshold: 75, dailyLimit: 20,
    boards: { linkedin:true, indeed:true, wellfound:true, naukri:false, greenhouse:true, lever:true, workday:false, ashby:true },
  });
  const [emailConnected, setEmailConnected] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);

  const simulateParse = () => {
    setParsing(true);
    setTimeout(() => {
      setParsed({
        name: "Alex Johnson",
        email: "alex@example.com",
        skills: ["React","TypeScript","Node.js","PostgreSQL","AWS","Docker"],
        experience: "5 years",
        currentRole: "Senior Software Engineer",
        education: "B.S. Computer Science, UC Berkeley",
        summary: "Full-stack engineer with 5 years experience in React, Node.js and cloud infrastructure.",
      });
      setParsing(false);
    }, 2200);
  };

  const simulateLaunch = () => {
    setLaunching(true);
    setTimeout(() => { setLaunching(false); setLaunched(true); }, 3000);
  };

  const next = () => setStep(s => Math.min(s+1, STEPS.length-1));
  const back = () => setStep(s => Math.max(s-1, 0));

  const stepContent = [
    // ── Step 0: Welcome ────────────────────────────────────────
    <div key="welcome" style={{ textAlign:"center", padding:"20px 0" }}>
      <div style={{ fontSize:64, marginBottom:24 }}>👋</div>
      <h2 style={{ fontSize:32, fontWeight:800, letterSpacing:"-1.5px", marginBottom:16, color:C.t1 }}>
        Welcome to Job Hunter AI
      </h2>
      <p style={{ fontSize:16, color:C.t2, lineHeight:1.8, maxWidth:480, margin:"0 auto 32px" }}>
        We'll have your AI agent running in under 5 minutes. It'll find jobs, apply automatically, follow up with recruiters, and prep you for interviews.
      </p>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:40 }}>
        {[
          { icon:"🔍", text:"Scrapes 17+ job boards every 2 hours" },
          { icon:"🤖", text:"Auto-applies to matching jobs while you sleep" },
          { icon:"🎤", text:"Generates custom interview prep per interview" },
        ].map(({ icon, text }) => (
          <div key={text} style={{ background:C.s3, border:`1px solid ${C.b2}`, borderRadius:10, padding:"20px 16px", textAlign:"center" }}>
            <div style={{ fontSize:28, marginBottom:10 }}>{icon}</div>
            <div style={{ fontSize:12, color:C.t2, lineHeight:1.6 }}>{text}</div>
          </div>
        ))}
      </div>
      <button onClick={next} style={{ padding:"14px 48px", borderRadius:10, background:C.acid, color:"#000", fontWeight:800, fontSize:16, border:"none", cursor:"pointer" }}>
        Let's get started →
      </button>
    </div>,

    // ── Step 1: Resume ─────────────────────────────────────────
    <div key="resume">
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-1px", marginBottom:8 }}>Upload your resume</h2>
      <p style={{ color:C.t2, fontSize:14, marginBottom:28 }}>Our AI will extract your skills, experience, and salary expectations automatically.</p>
      <DropZone file={resumeFile} onFile={f => { setResumeFile(f); setParsed(null); }} />
      {resumeFile && !parsed && (
        <button onClick={simulateParse} disabled={parsing} style={{
          marginTop:20, width:"100%", padding:"13px 0", borderRadius:9,
          background: parsing ? C.s3 : C.acid, color: parsing ? C.t2 : "#000",
          fontWeight:700, fontSize:15, border: parsing ? `1px solid ${C.b2}` : "none", cursor:"pointer",
        }}>
          {parsing ? "🤖 AI parsing your resume…" : "Parse with AI →"}
        </button>
      )}
      {parsed && (
        <div style={{ marginTop:20, background:C.s2, border:`1px solid ${C.acid}40`, borderRadius:10, padding:20 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <span style={{ fontSize:13, fontWeight:700, color:C.acid }}>✓ Resume parsed successfully</span>
            <span style={{ fontSize:11, color:C.t3, fontFamily:"var(--mono)" }}>{parsed.experience} experience detected</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div><div style={{ fontSize:10, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", marginBottom:4 }}>CURRENT ROLE</div><div style={{ fontSize:13, color:C.t1 }}>{parsed.currentRole}</div></div>
            <div><div style={{ fontSize:10, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", marginBottom:4 }}>EDUCATION</div><div style={{ fontSize:13, color:C.t1 }}>{parsed.education}</div></div>
          </div>
          <div style={{ marginTop:14 }}>
            <div style={{ fontSize:10, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", marginBottom:8 }}>SKILLS DETECTED</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {parsed.skills.map(s => (
                <span key={s} style={{ padding:"3px 10px", borderRadius:5, background:`${C.acid}15`, color:C.acid, fontSize:11, fontFamily:"var(--mono)", border:`1px solid ${C.acid}25` }}>{s}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>,

    // ── Step 2: Preferences ────────────────────────────────────
    <div key="prefs">
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-1px", marginBottom:8 }}>Set your preferences</h2>
      <p style={{ color:C.t2, fontSize:14, marginBottom:24 }}>Tell the agent exactly what to look for.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
        <div>
          <label style={{ fontSize:12, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", display:"block", marginBottom:8 }}>TARGET ROLES</label>
          <TagInput tags={prefs.roles} onAdd={v => setPrefs(p => ({...p, roles:[...p.roles,v]}))} onRemove={v => setPrefs(p => ({...p, roles:p.roles.filter(r=>r!==v)}))} placeholder="Type a role and press Enter…" />
        </div>
        <div>
          <label style={{ fontSize:12, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", display:"block", marginBottom:8 }}>LOCATIONS</label>
          <TagInput tags={prefs.locations} onAdd={v => setPrefs(p => ({...p, locations:[...p.locations,v]}))} onRemove={v => setPrefs(p => ({...p, locations:p.locations.filter(l=>l!==v)}))} placeholder="City, country, or Remote…" color={C.blue} />
        </div>
        <div>
          <label style={{ fontSize:12, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", display:"block", marginBottom:12 }}>SALARY RANGE (USD)</label>
          <div style={{ display:"flex", gap:12 }}>
            {[["Min", "minSalary"], ["Max", "maxSalary"]].map(([label, key]) => (
              <div key={key} style={{ flex:1 }}>
                <div style={{ fontSize:11, color:C.t3, marginBottom:5 }}>{label}</div>
                <input type="number" value={prefs[key]} onChange={e => setPrefs(p => ({...p,[key]:+e.target.value}))}
                  style={{ width:"100%", padding:"10px 12px", borderRadius:7, background:C.s3, border:`1px solid ${C.b2}`, color:C.t1, fontSize:14, outline:"none", fontFamily:"inherit" }} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <label style={{ fontSize:12, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", display:"block", marginBottom:10 }}>WORK TYPE</label>
          <div style={{ display:"flex", gap:8 }}>
            {[["remote","Remote"],["hybrid","Hybrid"],["onsite","On-site"]].map(([key,label]) => (
              <button key={key} onClick={() => setPrefs(p => ({...p,[key]:!p[key]}))} style={{
                flex:1, padding:"10px 0", borderRadius:8, border:`1.5px solid ${prefs[key] ? C.acid+"60" : C.b2}`,
                background: prefs[key] ? `${C.acid}12` : C.s3, color: prefs[key] ? C.acid : C.t2,
                fontWeight: prefs[key] ? 600 : 400, fontSize:13, cursor:"pointer", fontFamily:"inherit",
              }}>{label}</button>
            ))}
          </div>
        </div>
        <div>
          <Toggle on={prefs.autoApply} onChange={v => setPrefs(p => ({...p, autoApply:v}))} label="Auto-apply to matching jobs" sub="Bot will submit applications automatically above your match threshold" />
          <div style={{ padding:"16px 0" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <span style={{ fontSize:13, color:C.t1 }}>Match threshold</span>
              <span style={{ fontFamily:"var(--mono)", fontSize:13, color:C.acid }}>{prefs.matchThreshold}%</span>
            </div>
            <input type="range" min={50} max={95} step={5} value={prefs.matchThreshold} onChange={e => setPrefs(p => ({...p,matchThreshold:+e.target.value}))}
              style={{ width:"100%", accentColor:C.acid }} />
          </div>
          <Toggle on={prefs.dailyLimit <= 20} onChange={v => setPrefs(p => ({...p,dailyLimit: v ? 20 : 50}))} label={`Daily application limit: ${prefs.dailyLimit}/day`} sub="Prevents triggering platform rate limits" />
        </div>
      </div>
    </div>,

    // ── Step 3: Email ──────────────────────────────────────────
    <div key="email">
      <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-1px", marginBottom:8 }}>Connect your email</h2>
      <p style={{ color:C.t2, fontSize:14, marginBottom:28 }}>The AI reads recruiter replies to update your application status automatically.</p>
      {!emailConnected ? (
        <div>
          <button onClick={() => setEmailConnected(true)} style={{
            width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:14,
            padding:"18px 0", borderRadius:10, border:`1.5px solid ${C.b2}`,
            background:C.s2, color:C.t1, fontSize:15, fontWeight:600, cursor:"pointer", marginBottom:12, fontFamily:"inherit",
          }}>
            <svg width={22} height={22} viewBox="0 0 24 24"><path fill="#EA4335" d="M5.266 9.765A7.077 7.077 0 0 1 12 4.909c1.69 0 3.218.6 4.418 1.582L19.91 3c-2.1-1.979-4.962-3-7.91-3C6.454 0 2.362 2.675.454 6.59l4.812 3.175z"/><path fill="#34A853" d="M16.04 18.013c-1.09.703-2.474 1.078-4.04 1.078a7.077 7.077 0 0 1-6.723-4.823l-4.821 3.169C2.305 21.343 6.479 24 12 24c2.933 0 5.735-.995 7.834-2.952l-3.793-3.035z"/><path fill="#4A90E2" d="M19.834 21.048C22.015 19.013 23.454 15.929 23.454 12c0-.695-.07-1.372-.189-2.032H12v4.051h6.347c-.331 1.663-1.299 2.985-2.588 3.934l4.075 3.095z"/><path fill="#FBBC05" d="M5.277 14.268A7.12 7.12 0 0 1 4.909 12c0-.782.125-1.533.357-2.235L.454 6.59A11.934 11.934 0 0 0 0 12c0 1.92.445 3.73 1.218 5.337l4.059-3.069z"/></svg>
            Continue with Gmail
          </button>
          <div style={{ display:"flex", alignItems:"center", gap:12, margin:"16px 0" }}>
            <div style={{ flex:1, height:1, background:C.b1 }} />
            <span style={{ fontSize:12, color:C.t3 }}>or</span>
            <div style={{ flex:1, height:1, background:C.b1 }} />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <input placeholder="IMAP host" style={{ padding:"11px 14px", borderRadius:8, background:C.s3, border:`1px solid ${C.b2}`, color:C.t1, fontSize:13, outline:"none", fontFamily:"inherit" }} />
            <input placeholder="Port" style={{ padding:"11px 14px", borderRadius:8, background:C.s3, border:`1px solid ${C.b2}`, color:C.t1, fontSize:13, outline:"none", fontFamily:"inherit" }} />
            <input placeholder="Email address" style={{ padding:"11px 14px", borderRadius:8, background:C.s3, border:`1px solid ${C.b2}`, color:C.t1, fontSize:13, outline:"none", gridColumn:"1/-1", fontFamily:"inherit" }} />
            <input type="password" placeholder="App password" style={{ padding:"11px 14px", borderRadius:8, background:C.s3, border:`1px solid ${C.b2}`, color:C.t1, fontSize:13, outline:"none", gridColumn:"1/-1", fontFamily:"inherit" }} />
          </div>
          <p style={{ fontSize:12, color:C.t3, marginTop:16, lineHeight:1.6 }}>
            🔒 Credentials are encrypted at rest (AES-256). We only read job-related emails — never personal.
          </p>
        </div>
      ) : (
        <div style={{ background:C.s2, border:`1px solid ${C.acid}40`, borderRadius:12, padding:28, textAlign:"center" }}>
          <div style={{ fontSize:48, marginBottom:16 }}>✅</div>
          <div style={{ fontSize:16, fontWeight:700, color:C.acid, marginBottom:8 }}>Gmail connected</div>
          <div style={{ fontSize:13, color:C.t2, marginBottom:20 }}>alex@gmail.com · AI email monitoring active</div>
          <div style={{ display:"flex", flexDirection:"column", gap:10, textAlign:"left" }}>
            {["Reading recruiter replies","Updating application statuses","Scheduling follow-ups","Detecting interview invites"].map(f => (
              <div key={f} style={{ display:"flex", gap:10, alignItems:"center", fontSize:13, color:C.t2 }}>
                <span style={{ color:C.acid }}>✓</span>{f}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>,

    // ── Step 4: Launch ─────────────────────────────────────────
    <div key="launch" style={{ textAlign:"center" }}>
      {!launched ? (
        <>
          <div style={{ fontSize:56, marginBottom:20 }}>{launching ? "⚙️" : "🚀"}</div>
          <h2 style={{ fontSize:28, fontWeight:800, letterSpacing:"-1px", marginBottom:12 }}>
            {launching ? "Starting your AI agent…" : "You're all set!"}
          </h2>
          {!launching && (
            <>
              <p style={{ color:C.t2, fontSize:14, lineHeight:1.8, maxWidth:480, margin:"0 auto 32px" }}>
                Your AI agent is configured and ready. It will start scraping jobs immediately and apply to matches above your {prefs.matchThreshold}% threshold.
              </p>
              <div style={{ background:C.s2, border:`1px solid ${C.b1}`, borderRadius:12, padding:20, marginBottom:32, textAlign:"left" }}>
                <div style={{ fontSize:12, color:C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", marginBottom:14 }}>YOUR CONFIGURATION</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  {[
                    ["Target roles", prefs.roles.join(", ") || "Any"],
                    ["Locations", prefs.locations.join(", ") || "Any / Remote"],
                    ["Match threshold", `${prefs.matchThreshold}%`],
                    ["Daily limit", `${prefs.dailyLimit} applications`],
                    ["Auto-apply", prefs.autoApply ? "Enabled" : "Manual review"],
                    ["Email monitoring", emailConnected ? "Gmail connected" : "Not connected"],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div style={{ fontSize:10, color:C.t3, marginBottom:3 }}>{k}</div>
                      <div style={{ fontSize:13, color:C.t1, fontWeight:500 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
              <button onClick={simulateLaunch} style={{ padding:"16px 56px", borderRadius:10, background:C.acid, color:"#000", fontWeight:800, fontSize:17, border:"none", cursor:"pointer" }}>
                🚀 Launch my AI agent
              </button>
            </>
          )}
          {launching && (
            <div style={{ display:"flex", flexDirection:"column", gap:12, maxWidth:360, margin:"0 auto", textAlign:"left" }}>
              {["Connecting to job boards…","Starting scraper workers…","Loading your resume profile…","Calibrating AI match engine…","Activating email monitor…"].map((msg, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 16px", background:C.s2, borderRadius:8, border:`1px solid ${C.b1}` }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:C.acid, animation:"pulse 1s infinite", flexShrink:0 }} />
                  <span style={{ fontSize:13, color:C.t2 }}>{msg}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div>
          <div style={{ fontSize:64, marginBottom:20 }}>🎉</div>
          <h2 style={{ fontSize:28, fontWeight:800, letterSpacing:"-1px", marginBottom:12, color:C.acid }}>
            Your agent is live!
          </h2>
          <p style={{ color:C.t2, fontSize:15, lineHeight:1.8, maxWidth:440, margin:"0 auto 36px" }}>
            The first job scan is running now. You'll get a WhatsApp notification when the first matches are found. Sit back and let AI do the work.
          </p>
          <a href="/dashboard" style={{ display:"inline-block", padding:"14px 40px", borderRadius:10, background:C.acid, color:"#000", fontWeight:800, fontSize:16, cursor:"pointer" }}>
            Go to dashboard →
          </a>
        </div>
      )}
    </div>,
  ];

  return (
    <div style={{ background:C.bg, minHeight:"100vh", display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"40px 20px", fontFamily:"Bricolage Grotesque, system-ui, sans-serif", color:C.t1 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=Geist+Mono:wght@400;500;600&display=swap');:root{--mono:'Geist Mono',monospace;}*{box-sizing:border-box;}`}</style>
      <div style={{ width:"100%", maxWidth:560 }}>
        {/* Progress bar */}
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:40, position:"relative" }}>
          <div style={{ position:"absolute", top:15, left:0, right:0, height:1, background:C.b1, zIndex:0 }} />
          <div style={{ position:"absolute", top:15, left:0, height:1, background:C.acid, zIndex:1, transition:"width .4s", width:`${(step/(STEPS.length-1))*100}%` }} />
          {STEPS.map(({ id, label, icon }, i) => (
            <div key={id} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8, zIndex:2, cursor: i <= step ? "pointer" : "default" }} onClick={() => i < step && setStep(i)}>
              <div style={{ width:30, height:30, borderRadius:"50%", border:`2px solid ${i <= step ? C.acid : C.b2}`, background: i < step ? C.acid : i === step ? C.s2 : C.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, transition:"all .3s" }}>
                {i < step ? <span style={{ color:"#000", fontWeight:700 }}>✓</span> : <span>{icon}</span>}
              </div>
              <span style={{ fontSize:10, color: i <= step ? C.acid : C.t3, fontFamily:"var(--mono)", letterSpacing:"1px", textTransform:"uppercase" }}>{label}</span>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div style={{ background:C.s1, border:`1px solid ${C.b1}`, borderRadius:14, padding:"36px 36px" }}>
          {stepContent[step]}
        </div>

        {/* Navigation */}
        {step > 0 && step < STEPS.length - 1 && (
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:20 }}>
            <button onClick={back} style={{ padding:"12px 24px", borderRadius:8, border:`1px solid ${C.b2}`, background:"none", color:C.t2, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
              ← Back
            </button>
            <button onClick={next} style={{ padding:"12px 28px", borderRadius:8, background:C.acid, color:"#000", fontWeight:700, fontSize:13, border:"none", cursor:"pointer", fontFamily:"inherit" }}>
              Continue →
            </button>
          </div>
        )}
        {step === 1 && (
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:20 }}>
            <button onClick={back} style={{ padding:"12px 24px", borderRadius:8, border:`1px solid ${C.b2}`, background:"none", color:C.t2, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>← Back</button>
            <button onClick={next} disabled={!resumeFile} style={{ padding:"12px 28px", borderRadius:8, background: resumeFile ? C.acid : C.s3, color: resumeFile ? "#000" : C.t3, fontWeight:700, fontSize:13, border:"none", cursor: resumeFile ? "pointer" : "not-allowed", fontFamily:"inherit" }}>
              Continue →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
