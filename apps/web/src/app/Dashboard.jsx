import { useState, useCallback, useRef } from "react";

/* ─── Google Fonts injection ──────────────────────────────────────── */
const FontLink = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600;700&family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&display=swap');
  `}</style>
);

/* ─── Design tokens (inlined for artifact) ────────────────────────── */
const G = {
  bg: "#050608", s1: "#0a0c10", s2: "#0f1218", s3: "#141820", s4: "#1a2030",
  b1: "#1c2333", b2: "#232d40", b3: "#2a3650",
  t1: "#edf2ff", t2: "#8898b8", t3: "#4a5878", t4: "#2d3a52",
  acid: "#00ff88", blue: "#3b82f6", amber: "#f59e0b",
  red: "#f43f5e", violet: "#8b5cf6", cyan: "#06b6d4",
  mono: "'Geist Mono','Fira Code',monospace",
  ui: "'Bricolage Grotesque',system-ui,sans-serif",
};
const acid_dim = "rgba(0,255,136,.12)";
const blue_dim  = "rgba(59,130,246,.12)";
const amber_dim = "rgba(245,158,11,.12)";
const red_dim   = "rgba(244,63,94,.12)";
const vio_dim   = "rgba(139,92,246,.12)";
const cyan_dim  = "rgba(6,182,212,.12)";

/* ─── Mock data ────────────────────────────────────────────────────── */
const JOBS = [
  { id:1, title:"Senior Software Engineer", company:"Stripe", logo:"💳", location:"Remote", salary:"$180–220k", match:94, source:"LinkedIn", posted:"2h ago", status:"new", tags:["TypeScript","Node.js","PostgreSQL"] },
  { id:2, title:"Staff Engineer, Platform", company:"Vercel", logo:"▲", location:"SF / Remote", salary:"$200–240k", match:91, source:"Wellfound", posted:"5h ago", status:"new", tags:["Next.js","Rust","Kubernetes"] },
  { id:3, title:"Principal Backend Engineer", company:"Linear", logo:"⬡", location:"Remote", salary:"$190–230k", match:88, source:"Ashby", posted:"1d ago", status:"saved", tags:["Elixir","PostgreSQL","GraphQL"] },
  { id:4, title:"Engineering Manager", company:"Figma", logo:"🎨", location:"NYC / Remote", salary:"$220–260k", match:82, source:"Greenhouse", posted:"2d ago", status:"new", tags:["Leadership","React","System Design"] },
  { id:5, title:"Full-Stack Engineer", company:"Loom", logo:"🎬", location:"Remote", salary:"$160–190k", match:79, source:"Lever", posted:"3d ago", status:"saved", tags:["React","Go","AWS"] },
  { id:6, title:"Senior Product Engineer", company:"Notion", logo:"📝", location:"NYC", salary:"$170–200k", match:76, source:"LinkedIn", posted:"4d ago", status:"new", tags:["React","TypeScript","Design"] },
];

const APPLICATIONS = [
  { id:1, title:"Senior Software Engineer", company:"Stripe", logo:"💳", appliedAt:"Mar 10", status:"REVIEWING", followUp:1, nextFollowUp:"Mar 17", match:94, recruiter:"Sarah Chen" },
  { id:2, title:"Staff Engineer, Platform", company:"Vercel", logo:"▲", appliedAt:"Mar 8", status:"INTERVIEW_SCHEDULED", followUp:0, nextFollowUp:null, match:91, recruiter:"Alex Kim" },
  { id:3, title:"Senior Backend Engineer", company:"PlanetScale", logo:"🌏", appliedAt:"Mar 5", status:"APPLIED", followUp:0, nextFollowUp:"Mar 12", match:87, recruiter:null },
  { id:4, title:"Principal Engineer", company:"Linear", logo:"⬡", appliedAt:"Mar 3", status:"FOLLOW_UP_SENT", followUp:2, nextFollowUp:"Mar 17", match:88, recruiter:"Jordan Lee" },
  { id:5, title:"Engineering Manager", company:"Figma", logo:"🎨", appliedAt:"Feb 28", status:"REJECTED", followUp:2, nextFollowUp:null, match:82, recruiter:"Maya Patel" },
  { id:6, title:"Senior Engineer", company:"Retool", logo:"🔧", appliedAt:"Feb 25", status:"OFFER_RECEIVED", followUp:0, nextFollowUp:null, match:89, recruiter:"Chris Wang" },
  { id:7, title:"Full-Stack Engineer", company:"Loom", logo:"🎬", appliedAt:"Feb 20", status:"WITHDRAWN", followUp:1, nextFollowUp:null, match:79, recruiter:null },
];

const INTERVIEWS = [
  { id:1, title:"Staff Engineer", company:"Vercel", logo:"▲", date:"Mar 14, 2026", time:"2:00 PM PST", type:"Technical", round:1, platform:"Zoom", interviewer:"Guillermo Rauch", status:"CONFIRMED", meetingLink:"https://zoom.us/j/123" },
  { id:2, title:"Senior Engineer", company:"Retool", logo:"🔧", date:"Mar 16, 2026", time:"10:00 AM PST", type:"Final Round", round:3, platform:"Google Meet", interviewer:"David Hsu, CTO", status:"CONFIRMED", meetingLink:"https://meet.google.com/abc" },
  { id:3, title:"Senior Software Engineer", company:"Stripe", logo:"💳", date:"Mar 19, 2026", time:"3:00 PM EST", type:"Phone Screen", round:1, platform:"Phone", interviewer:"Sarah Chen", status:"PENDING", meetingLink:null },
  { id:4, title:"Platform Lead", company:"Railway", logo:"🚂", date:"Mar 22, 2026", time:"11:00 AM PST", type:"System Design", round:2, platform:"Zoom", interviewer:"Jake Cooper", status:"CONFIRMED", meetingLink:"https://zoom.us/j/456" },
];

const NOTIFICATIONS = [
  { id:1, type:"interview", icon:"📅", title:"Interview confirmed — Vercel", desc:"Staff Engineer, Platform • Mar 14 @ 2:00 PM PST with Guillermo Rauch", time:"10 min ago", read:false, color:G.blue },
  { id:2, type:"offer", icon:"🎊", title:"Offer received — Retool", desc:"Senior Engineer • $195k base + equity. Review by Mar 20.", time:"2h ago", read:false, color:G.acid },
  { id:3, type:"followup", icon:"📤", title:"Follow-up sent — Stripe", desc:"2nd follow-up dispatched to Sarah Chen for Senior SWE role.", time:"4h ago", read:false, color:G.violet },
  { id:4, type:"match", icon:"⚡", title:"8 new job matches found", desc:"Top match: Staff Engineer at Vercel (94%). Tap to review.", time:"8h ago", read:true, color:G.amber },
  { id:5, type:"applied", icon:"✅", title:"Application submitted — Linear", desc:"Principal Backend Engineer role via Ashby. Follow-ups scheduled.", time:"1d ago", read:true, color:G.cyan },
  { id:6, type:"rejection", icon:"📋", title:"Application update — Figma", desc:"Engineering Manager role. Not selected. Follow-ups cancelled.", time:"2d ago", read:true, color:G.red },
  { id:7, type:"followup", icon:"📤", title:"1st follow-up sent — PlanetScale", desc:"Follow-up to hiring team for Senior Backend Engineer role.", time:"3d ago", read:true, color:G.violet },
  { id:8, type:"match", icon:"⚡", title:"12 new job matches found", desc:"Top match: Principal Engineer at Shopify (91%). Tap to review.", time:"4d ago", read:true, color:G.amber },
];

const FOLLOW_UPS = [
  { id:1, company:"Stripe", logo:"💳", role:"Senior Software Engineer", recruiter:"Sarah Chen", email:"sarah.chen@stripe.com", sentAt:"Mar 10", followUpNum:1, status:"SENT", subject:"Following up on Senior SWE application" },
  { id:2, company:"Linear", logo:"⬡", role:"Principal Backend Engineer", recruiter:"Jordan Lee", email:"jordan@linear.app", sentAt:"Mar 8", followUpNum:2, status:"SENT", subject:"Re: Principal Engineer role follow-up" },
  { id:3, company:"PlanetScale", logo:"🌏", role:"Senior Backend Engineer", recruiter:null, email:"jobs@planetscale.com", sentAt:"Mar 5", followUpNum:1, status:"SENT", subject:"Follow-up: Senior Backend Engineer application" },
  { id:4, company:"Railway", logo:"🚂", role:"Platform Lead", recruiter:"Jake Cooper", email:"jake@railway.app", sentAt:"Mar 1", followUpNum:1, status:"REPLIED", subject:"Platform Lead application" },
];

/* ─── Shared primitives ────────────────────────────────────────────── */
const statusConfig = {
  APPLIED:             { label:"Applied",         color:G.blue,   dim:blue_dim },
  REVIEWING:           { label:"Reviewing",       color:G.amber,  dim:amber_dim },
  INTERVIEW_SCHEDULED: { label:"Interview",       color:G.acid,   dim:acid_dim },
  FOLLOW_UP_SENT:      { label:"Follow-up Sent",  color:G.violet, dim:vio_dim },
  OFFER_RECEIVED:      { label:"Offer",           color:G.acid,   dim:acid_dim },
  REJECTED:            { label:"Rejected",        color:G.red,    dim:red_dim },
  WITHDRAWN:           { label:"Withdrawn",       color:G.t3,     dim:`rgba(74,88,120,.15)` },
};

const Badge = ({ color, dim, children, small }) => (
  <span style={{
    display:"inline-flex", alignItems:"center", gap:4,
    padding: small ? "2px 7px" : "3px 9px",
    borderRadius:4, background: dim, color,
    border:`1px solid ${color}33`,
    fontFamily:G.mono, fontSize:small?9:10,
    letterSpacing:.5, textTransform:"uppercase", fontWeight:600,
    whiteSpace:"nowrap",
  }}>{children}</span>
);

const ScoreBar = ({ score }) => {
  const color = score >= 85 ? G.acid : score >= 70 ? G.amber : G.red;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      <div style={{ flex:1, height:3, background:G.s4, borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${score}%`, height:"100%", background:color, borderRadius:2, transition:"width .6s" }} />
      </div>
      <span style={{ fontFamily:G.mono, fontSize:11, color, minWidth:32, textAlign:"right" }}>{score}%</span>
    </div>
  );
};

const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{
    background:G.s2, border:`1px solid ${G.b1}`, borderRadius:10,
    overflow:"hidden", transition:"border-color .2s",
    cursor: onClick ? "pointer" : "default", ...style,
  }}
  onMouseEnter={e => { if(onClick) e.currentTarget.style.borderColor = G.b3; }}
  onMouseLeave={e => { if(onClick) e.currentTarget.style.borderColor = G.b1; }}>
    {children}
  </div>
);

const Btn = ({ children, variant="primary", onClick, style, small }) => {
  const base = {
    display:"inline-flex", alignItems:"center", gap:7,
    padding: small ? "6px 12px" : "9px 18px",
    borderRadius:8, fontFamily:G.ui,
    fontSize: small ? 12 : 13, fontWeight:600,
    cursor:"pointer", border:"none", transition:"all .15s",
  };
  const variants = {
    primary:   { background:G.acid, color:G.bg },
    secondary: { background:G.s3, color:G.t2, border:`1px solid ${G.b2}` },
    ghost:     { background:"transparent", color:G.t2, border:`1px solid ${G.b1}` },
    danger:    { background:red_dim, color:G.red, border:`1px solid ${G.red}33` },
  };
  return (
    <button style={{...base, ...variants[variant], ...style}} onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.opacity = ".85"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "translateY(0)"; }}>
      {children}
    </button>
  );
};

const Input = ({ label, placeholder, type="text", value, onChange, style }) => (
  <div style={{ marginBottom:18, ...style }}>
    {label && <div style={{ fontFamily:G.mono, fontSize:10, letterSpacing:2, textTransform:"uppercase", color:G.t3, marginBottom:6 }}>{label}</div>}
    <input type={type} placeholder={placeholder} value={value} onChange={onChange} style={{
      width:"100%", background:G.s3, border:`1px solid ${G.b2}`,
      borderRadius:8, padding:"9px 13px",
      fontFamily:G.ui, fontSize:13, color:G.t1, outline:"none",
      transition:"border-color .15s, box-shadow .15s",
    }}
    onFocus={e => { e.target.style.borderColor = G.acid; e.target.style.boxShadow = `0 0 0 2px ${acid_dim}`; }}
    onBlur={e => { e.target.style.borderColor = G.b2; e.target.style.boxShadow = "none"; }}/>
  </div>
);

const Mono = ({ children, color, size=11 }) => (
  <span style={{ fontFamily:G.mono, fontSize:size, color: color||G.t3 }}>{children}</span>
);

const SectionLabel = ({ children }) => (
  <div style={{
    fontFamily:G.mono, fontSize:10, letterSpacing:3, textTransform:"uppercase",
    color:G.t3, marginBottom:14, display:"flex", alignItems:"center", gap:12,
  }}>
    {children}
    <div style={{ flex:1, height:1, background:G.b1 }} />
  </div>
);

const LiveDot = ({ color=G.acid }) => (
  <span style={{
    display:"inline-block", width:6, height:6, borderRadius:"50%",
    background:color,
    animation:"pulse 2s ease-in-out infinite",
  }} />
);

/* ─── Topbar ────────────────────────────────────────────────────────── */
const Topbar = ({ page, onNav, unread }) => {
  const ticker = [
    { label:"APPLIED", val:7, up:true },
    { label:"MATCHES", val:24, up:true },
    { label:"RESPONSE RATE", val:"43%", up:true },
    { label:"INTERVIEWS", val:4, up:true },
    { label:"OFFERS", val:1, up:true },
  ];
  return (
    <div style={{
      display:"flex", alignItems:"center", height:52,
      borderBottom:`1px solid ${G.b1}`,
      background:G.s1, padding:"0 20px", gap:0,
      position:"sticky", top:0, zIndex:100,
    }}>
      {/* Logo */}
      <div style={{ display:"flex", alignItems:"center", gap:10, paddingRight:20, borderRight:`1px solid ${G.b1}`, cursor:"pointer" }}
        onClick={() => onNav("dashboard")}>
        <div style={{
          width:28, height:28, borderRadius:7, background:G.acid,
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:14, fontWeight:800, color:G.bg, fontFamily:G.mono,
        }}>JH</div>
        <div>
          <div style={{ fontFamily:G.ui, fontSize:13, fontWeight:700, color:G.t1, letterSpacing:-.3 }}>Job Hunter</div>
          <div style={{ fontFamily:G.mono, fontSize:9, color:G.t3, letterSpacing:2 }}>AI AGENT</div>
        </div>
      </div>

      {/* Ticker */}
      <div style={{ display:"flex", gap:28, padding:"0 24px", flex:1, overflow:"hidden" }}>
        {ticker.map(t => (
          <div key={t.label} style={{ display:"flex", alignItems:"center", gap:5, whiteSpace:"nowrap" }}>
            <Mono color={G.t3} size={10}>{t.label}</Mono>
            <Mono color={t.up ? G.acid : G.red} size={11}>{t.up ? "↑":"↓"} {t.val}</Mono>
          </div>
        ))}
      </div>

      {/* Right actions */}
      <div style={{ display:"flex", alignItems:"center", gap:8, borderLeft:`1px solid ${G.b1}`, paddingLeft:16 }}>
        <button onClick={() => onNav("notifications")} style={{
          position:"relative", width:34, height:34, borderRadius:8,
          background: page==="notifications" ? acid_dim : "transparent",
          border:`1px solid ${page==="notifications" ? G.acid+"33" : G.b1}`,
          cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:15, transition:"all .15s",
        }}>
          🔔
          {unread > 0 && (
            <div style={{
              position:"absolute", top:-3, right:-3,
              background:G.red, color:"white",
              borderRadius:10, fontSize:8, fontFamily:G.mono,
              padding:"1px 4px", minWidth:15, textAlign:"center",
              lineHeight:1.4,
            }}>{unread}</div>
          )}
        </button>
        <div style={{
          width:32, height:32, borderRadius:"50%",
          background:`linear-gradient(135deg, ${G.violet}, ${G.blue})`,
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:12, fontWeight:700, color:"white", cursor:"pointer",
          fontFamily:G.ui,
        }}>AJ</div>
      </div>
    </div>
  );
};

/* ─── Sidebar ────────────────────────────────────────────────────────── */
const NAV = [
  { id:"dashboard",      icon:"⬡", label:"Overview" },
  { id:"jobs",           icon:"⚡", label:"Matched Jobs",   badge:24 },
  { id:"applications",   icon:"📬", label:"Applications",   badge:7 },
  { id:"interviews",     icon:"📅", label:"Interviews",     badge:4 },
  { id:"followups",      icon:"📤", label:"Follow-ups",     badge:3 },
  { id:"notifications",  icon:"🔔", label:"Notifications" },
  null, // divider
  { id:"resume",         icon:"📄", label:"Resume" },
  { id:"preferences",    icon:"⚙", label:"Preferences" },
];

const Sidebar = ({ page, onNav, unread }) => (
  <div style={{
    background:G.s1, borderRight:`1px solid ${G.b1}`,
    display:"flex", flexDirection:"column",
    width:220, height:"calc(100vh - 52px)",
    position:"sticky", top:52, overflowY:"auto",
    padding:"12px 10px",
  }}>
    <div style={{ fontFamily:G.mono, fontSize:9, letterSpacing:2.5, textTransform:"uppercase", color:G.t4, padding:"6px 10px 8px" }}>Navigation</div>
    {NAV.map((item, i) => {
      if (!item) return <div key={i} style={{ height:1, background:G.b1, margin:"10px 0" }} />;
      const active = page === item.id;
      const badge = item.id === "notifications" ? unread : item.badge;
      return (
        <div key={item.id} onClick={() => onNav(item.id)} style={{
          display:"flex", alignItems:"center", gap:10,
          padding:"8px 10px", borderRadius:8,
          fontSize:13, fontWeight:500,
          color: active ? G.acid : G.t2,
          background: active ? acid_dim : "transparent",
          border:`1px solid ${active ? G.acid+"22" : "transparent"}`,
          cursor:"pointer", transition:"all .15s", marginBottom:2,
        }}
        onMouseEnter={e => { if(!active) { e.currentTarget.style.background = G.s3; e.currentTarget.style.color = G.t1; }}}
        onMouseLeave={e => { if(!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = G.t2; }}}>
          <span style={{ fontSize:15, width:18, textAlign:"center" }}>{item.icon}</span>
          <span style={{ flex:1 }}>{item.label}</span>
          {badge > 0 && (
            <span style={{
              background: active ? G.acid : item.id==="notifications" ? G.red : blue_dim,
              color: active ? G.bg : item.id==="notifications" ? "white" : G.blue,
              borderRadius:10, fontFamily:G.mono, fontSize:9,
              padding:"1px 6px", minWidth:18, textAlign:"center",
            }}>{badge}</span>
          )}
        </div>
      );
    })}

    {/* Footer */}
    <div style={{ marginTop:"auto", padding:"12px 10px 4px", borderTop:`1px solid ${G.b1}` }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0" }}>
        <LiveDot />
        <Mono color={G.t3} size={10}>Bot running · 3 tasks</Mono>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 0" }}>
        <div style={{ width:6, height:6, borderRadius:"50%", background:G.blue }} />
        <Mono color={G.t3} size={10}>2 emails syncing</Mono>
      </div>
    </div>
  </div>
);

/* ─── LOGIN PAGE ─────────────────────────────────────────────────────── */
const LoginPage = ({ onLogin }) => {
  const [email, setEmail] = useState("alex@example.com");
  const [pass, setPass] = useState("••••••••");
  const [loading, setLoading] = useState(false);

  const handle = () => {
    setLoading(true);
    setTimeout(() => { setLoading(false); onLogin(); }, 1200);
  };

  const stats = [
    { n:"12,400+", l:"Jobs scraped daily" },
    { n:"94%",     l:"Average match score" },
    { n:"3× faster", l:"Interview conversion" },
    { n:"$0",      l:"Manual effort" },
  ];

  return (
    <div style={{ minHeight:"100vh", display:"grid", gridTemplateColumns:"1fr 440px", background:G.bg }}>
      {/* Left panel */}
      <div style={{
        padding:60, display:"flex", flexDirection:"column", justifyContent:"space-between",
        borderRight:`1px solid ${G.b1}`, background:G.s1, position:"relative", overflow:"hidden",
      }}>
        {/* Ambient */}
        <div style={{
          position:"absolute", inset:0, pointerEvents:"none",
          background:`radial-gradient(ellipse 80% 60% at 20% 50%, rgba(0,255,136,.06) 0, transparent 60%),
                      radial-gradient(ellipse 60% 40% at 80% 80%, rgba(59,130,246,.05) 0, transparent 60%)`,
        }}/>

        {/* Logo */}
        <div style={{ position:"relative", zIndex:1 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:60 }}>
            <div style={{ width:40, height:40, borderRadius:10, background:G.acid, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, fontWeight:800, color:G.bg, fontFamily:G.mono }}>JH</div>
            <div>
              <div style={{ fontFamily:G.ui, fontSize:18, fontWeight:800, letterSpacing:-.5, color:G.t1 }}>Job Hunter AI</div>
              <Mono color={G.t3} size={10}>AUTONOMOUS JOB SEARCH AGENT</Mono>
            </div>
          </div>
          <h1 style={{ fontFamily:G.ui, fontSize:48, fontWeight:800, letterSpacing:-2, lineHeight:1.05, color:G.t1, marginBottom:20 }}>
            Your AI agent<br/>
            <span style={{ color:G.acid }}>finds, applies,</span><br/>
            follows up.
          </h1>
          <p style={{ fontSize:16, color:G.t2, lineHeight:1.75, maxWidth:480 }}>
            Scrapes 40+ job boards, scores every match with AI, auto-applies with your tailored resume, sends follow-up emails, and preps you for interviews. All while you sleep.
          </p>
        </div>

        {/* Stats */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, position:"relative", zIndex:1 }}>
          {stats.map(s => (
            <div key={s.n} style={{ background:G.s2, border:`1px solid ${G.b1}`, borderRadius:10, padding:"16px 18px" }}>
              <div style={{ fontFamily:G.ui, fontSize:24, fontWeight:800, letterSpacing:-1, color:G.acid, marginBottom:4 }}>{s.n}</div>
              <Mono color={G.t3} size={11}>{s.l}</Mono>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div style={{ padding:"52px 48px", display:"flex", flexDirection:"column", justifyContent:"center", background:G.bg }}>
        <div style={{ marginBottom:36 }}>
          <h2 style={{ fontFamily:G.ui, fontSize:24, fontWeight:700, letterSpacing:-.6, color:G.t1, marginBottom:6 }}>Welcome back</h2>
          <Mono color={G.t3}>Sign in to your command center</Mono>
        </div>

        <Input label="Email" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/>
        <Input label="Password" type="password" value={pass} onChange={e=>setPass(e.target.value)} placeholder="••••••••"/>

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
          <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
            <div style={{ width:16, height:16, borderRadius:4, border:`1.5px solid ${G.acid}`, background:acid_dim, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <span style={{ color:G.acid, fontSize:10 }}>✓</span>
            </div>
            <span style={{ fontSize:13, color:G.t2 }}>Remember me</span>
          </label>
          <span style={{ fontSize:13, color:G.acid, cursor:"pointer" }}>Forgot password?</span>
        </div>

        <Btn onClick={handle} style={{ width:"100%", justifyContent:"center", fontSize:14, padding:"11px 0", marginBottom:16 }}>
          {loading ? "Signing in…" : "Sign in →"}
        </Btn>

        <div style={{ display:"flex", alignItems:"center", gap:12, margin:"20px 0" }}>
          <div style={{ flex:1, height:1, background:G.b1 }}/>
          <Mono color={G.t3} size={10}>OR CONTINUE WITH</Mono>
          <div style={{ flex:1, height:1, background:G.b1 }}/>
        </div>

        {["Continue with Google", "Continue with LinkedIn"].map(label => (
          <button key={label} style={{
            width:"100%", background:G.s2, border:`1px solid ${G.b2}`,
            borderRadius:8, padding:"10px 0", fontSize:13,
            color:G.t2, cursor:"pointer", marginBottom:10, fontFamily:G.ui,
            transition:"all .15s",
          }}
          onMouseEnter={e => { e.target.style.background = G.s3; e.target.style.color = G.t1; }}
          onMouseLeave={e => { e.target.style.background = G.s2; e.target.style.color = G.t2; }}>
            {label}
          </button>
        ))}

        <p style={{ textAlign:"center", marginTop:24, fontSize:13, color:G.t3 }}>
          No account? <span style={{ color:G.acid, cursor:"pointer" }}>Start free trial →</span>
        </p>
      </div>
    </div>
  );
};

/* ─── DASHBOARD PAGE ─────────────────────────────────────────────────── */
const DashboardPage = ({ onNav }) => {
  const stats = [
    { label:"MATCHED TODAY",  val:24,  delta:"+8 vs yesterday", color:G.acid,   icon:"⚡" },
    { label:"APPLIED",        val:7,   delta:"+2 today",        color:G.blue,   icon:"📬" },
    { label:"INTERVIEWS",     val:4,   delta:"2 this week",     color:G.violet, icon:"📅" },
    { label:"OFFERS",         val:1,   delta:"🎊 New!",         color:G.amber,  icon:"🎊" },
  ];

  const topMatches = JOBS.slice(0, 4);
  const recentApps = APPLICATIONS.slice(0, 4);
  const upcomingInterviews = INTERVIEWS.slice(0, 2);

  return (
    <div>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:28 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Overview</h1>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:4 }}>
            <LiveDot />
            <Mono color={G.t3}>Bot active · last scan 4 min ago · Thu Mar 12, 2026</Mono>
          </div>
        </div>
        <Btn onClick={() => onNav("preferences")} variant="secondary" small>Configure agent ⚙</Btn>
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:24 }}>
        {stats.map((s,i) => (
          <div key={s.label} style={{
            background:G.s2, border:`1px solid ${G.b1}`, borderRadius:10,
            padding:"18px 20px", cursor:"pointer", transition:"all .2s",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = s.color+"44"; e.currentTarget.style.transform = "translateY(-1px)"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = G.b1; e.currentTarget.style.transform = "translateY(0)"; }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
              <Mono color={G.t3} size={10}>{s.label}</Mono>
              <span style={{ fontSize:18 }}>{s.icon}</span>
            </div>
            <div style={{ fontFamily:G.ui, fontSize:32, fontWeight:800, letterSpacing:-1.5, color:s.color, lineHeight:1, marginBottom:8 }}>{s.val}</div>
            <Mono color={G.t3} size={10}>{s.delta}</Mono>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
        {/* Top Matches */}
        <Card>
          <div style={{ padding:"14px 18px 12px", borderBottom:`1px solid ${G.b1}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <Mono size={10} color={G.t3}>TOP MATCHES TODAY</Mono>
            <span onClick={() => onNav("jobs")} style={{ fontFamily:G.mono, fontSize:10, color:G.acid, cursor:"pointer" }}>View all →</span>
          </div>
          <div>
            {topMatches.map(job => (
              <div key={job.id} style={{
                padding:"12px 18px", borderBottom:`1px solid ${G.b1}`,
                display:"flex", alignItems:"center", gap:12, cursor:"pointer",
                transition:"background .15s",
              }}
              onMouseEnter={e => e.currentTarget.style.background = G.s3}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ fontSize:20, width:36, textAlign:"center", flexShrink:0 }}>{job.logo}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginBottom:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{job.title}</div>
                  <Mono color={G.t3}>{job.company} · {job.location}</Mono>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <div style={{ fontFamily:G.mono, fontSize:13, fontWeight:600, color: job.match >= 90 ? G.acid : G.amber }}>{job.match}%</div>
                  <Mono color={G.t3}>{job.posted}</Mono>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Recent Applications */}
        <Card>
          <div style={{ padding:"14px 18px 12px", borderBottom:`1px solid ${G.b1}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <Mono size={10} color={G.t3}>RECENT APPLICATIONS</Mono>
            <span onClick={() => onNav("applications")} style={{ fontFamily:G.mono, fontSize:10, color:G.acid, cursor:"pointer" }}>View all →</span>
          </div>
          <div>
            {recentApps.map(app => {
              const s = statusConfig[app.status];
              return (
                <div key={app.id} style={{
                  padding:"12px 18px", borderBottom:`1px solid ${G.b1}`,
                  display:"flex", alignItems:"center", gap:12, cursor:"pointer",
                  transition:"background .15s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = G.s3}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <div style={{ fontSize:20, width:36, textAlign:"center", flexShrink:0 }}>{app.logo}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginBottom:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{app.title}</div>
                    <Mono color={G.t3}>{app.company}</Mono>
                  </div>
                  <Badge color={s.color} dim={s.dim} small>{s.label}</Badge>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Upcoming interviews + follow-ups */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        <Card>
          <div style={{ padding:"14px 18px 12px", borderBottom:`1px solid ${G.b1}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <Mono size={10} color={G.t3}>UPCOMING INTERVIEWS</Mono>
            <span onClick={() => onNav("interviews")} style={{ fontFamily:G.mono, fontSize:10, color:G.acid, cursor:"pointer" }}>View all →</span>
          </div>
          {upcomingInterviews.map(iv => (
            <div key={iv.id} style={{ padding:"14px 18px", borderBottom:`1px solid ${G.b1}`, display:"flex", gap:14 }}>
              <div style={{ fontSize:22, flexShrink:0 }}>{iv.logo}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginBottom:2 }}>{iv.title} — {iv.company}</div>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                  <Badge color={G.blue} dim={blue_dim} small>{iv.type}</Badge>
                  <Mono color={G.t3}>{iv.date} · {iv.time}</Mono>
                </div>
                <Mono color={G.t3} size={10} style={{ marginTop:4 }}>with {iv.interviewer} · via {iv.platform}</Mono>
              </div>
            </div>
          ))}
        </Card>

        <Card>
          <div style={{ padding:"14px 18px 12px", borderBottom:`1px solid ${G.b1}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <Mono size={10} color={G.t3}>FOLLOW-UP EMAILS</Mono>
            <span onClick={() => onNav("followups")} style={{ fontFamily:G.mono, fontSize:10, color:G.acid, cursor:"pointer" }}>View all →</span>
          </div>
          {FOLLOW_UPS.slice(0,3).map(fu => (
            <div key={fu.id} style={{ padding:"12px 18px", borderBottom:`1px solid ${G.b1}`, display:"flex", gap:12, alignItems:"center" }}>
              <div style={{ fontSize:20, flexShrink:0 }}>{fu.logo}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginBottom:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{fu.role}</div>
                <Mono color={G.t3}>{fu.company} · Follow-up #{fu.followUpNum} · {fu.sentAt}</Mono>
              </div>
              <Badge color={fu.status==="REPLIED"?G.acid:G.violet} dim={fu.status==="REPLIED"?acid_dim:vio_dim} small>
                {fu.status}
              </Badge>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
};

/* ─── JOBS PAGE ──────────────────────────────────────────────────────── */
const JobsPage = () => {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(JOBS[0]);

  const filtered = JOBS.filter(j =>
    (filter === "all" || j.status === filter) &&
    (j.title.toLowerCase().includes(search.toLowerCase()) || j.company.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Matched Jobs</h1>
          <Mono color={G.t3}>24 new matches · AI-scored by fit to your profile</Mono>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn variant="secondary" small>⚙ Filter</Btn>
          <Btn small>⚡ Auto-apply top 5</Btn>
        </div>
      </div>

      {/* Search + filter tabs */}
      <div style={{ display:"flex", gap:10, marginBottom:16, alignItems:"center" }}>
        <input placeholder="Search jobs, companies…" value={search} onChange={e=>setSearch(e.target.value)} style={{
          flex:1, background:G.s2, border:`1px solid ${G.b2}`, borderRadius:8,
          padding:"8px 13px", fontFamily:G.ui, fontSize:13, color:G.t1, outline:"none",
        }}
        onFocus={e => { e.target.style.borderColor = G.acid; }}
        onBlur={e => { e.target.style.borderColor = G.b2; }}/>
        {["all","new","saved"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding:"7px 14px", borderRadius:7, fontFamily:G.mono, fontSize:10,
            letterSpacing:1, textTransform:"uppercase", cursor:"pointer",
            background: filter===f ? acid_dim : G.s2,
            color: filter===f ? G.acid : G.t3,
            border: `1px solid ${filter===f ? G.acid+"33" : G.b1}`,
          }}>{f}</button>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"340px 1fr", gap:14, height:"calc(100vh - 240px)" }}>
        {/* List */}
        <div style={{ background:G.s2, border:`1px solid ${G.b1}`, borderRadius:10, overflow:"hidden", display:"flex", flexDirection:"column" }}>
          <div style={{ overflowY:"auto", flex:1 }}>
            {filtered.map(job => (
              <div key={job.id} onClick={() => setSelected(job)} style={{
                padding:"14px 16px", borderBottom:`1px solid ${G.b1}`,
                cursor:"pointer", transition:"background .15s",
                background: selected?.id === job.id ? G.s3 : "transparent",
                borderLeft: selected?.id === job.id ? `2px solid ${G.acid}` : "2px solid transparent",
              }}
              onMouseEnter={e => { if(selected?.id!==job.id) e.currentTarget.style.background = G.s3; }}
              onMouseLeave={e => { if(selected?.id!==job.id) e.currentTarget.style.background = "transparent"; }}>
                <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
                  <div style={{ fontSize:22, flexShrink:0, width:36, textAlign:"center" }}>{job.logo}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{job.title}</div>
                    <Mono color={G.t2} size={11}>{job.company}</Mono>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6 }}>
                      <ScoreBar score={job.match} />
                    </div>
                    <div style={{ display:"flex", gap:5, marginTop:7, flexWrap:"wrap" }}>
                      {job.tags.slice(0,2).map(t => (
                        <span key={t} style={{ fontSize:10, fontFamily:G.mono, padding:"2px 6px", borderRadius:4, background:G.s4, color:G.t3, border:`1px solid ${G.b2}` }}>{t}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <Mono color={G.t3} size={10}>{job.posted}</Mono>
                    {job.status === "saved" && <div style={{ marginTop:4, fontSize:10 }}>🔖</div>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail */}
        {selected && (
          <Card style={{ overflowY:"auto" }}>
            <div style={{ padding:"24px 28px" }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:16, marginBottom:24 }}>
                <div style={{ fontSize:40, flexShrink:0 }}>{selected.logo}</div>
                <div style={{ flex:1 }}>
                  <h2 style={{ fontFamily:G.ui, fontSize:20, fontWeight:700, letterSpacing:-.5, color:G.t1, marginBottom:4 }}>{selected.title}</h2>
                  <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
                    <span style={{ fontSize:14, fontWeight:600, color:G.t2 }}>{selected.company}</span>
                    <Mono color={G.t3}>·</Mono>
                    <Mono color={G.t3}>{selected.location}</Mono>
                    <Mono color={G.t3}>·</Mono>
                    <Mono color={G.acid}>{selected.salary}</Mono>
                  </div>
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn variant="secondary" small>🔖 Save</Btn>
                  <Btn small>Apply now →</Btn>
                </div>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:24 }}>
                {[
                  { l:"AI MATCH", v:`${selected.match}%`, color:selected.match>=85?G.acid:G.amber },
                  { l:"SOURCE", v:selected.source, color:G.blue },
                  { l:"POSTED", v:selected.posted, color:G.t2 },
                ].map(s => (
                  <div key={s.l} style={{ background:G.s3, borderRadius:8, padding:"12px 14px" }}>
                    <Mono color={G.t3} size={9}>{s.l}</Mono>
                    <div style={{ fontFamily:G.ui, fontSize:16, fontWeight:700, color:s.color, marginTop:4 }}>{s.v}</div>
                  </div>
                ))}
              </div>

              <SectionLabel>Skills Required</SectionLabel>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:24 }}>
                {selected.tags.map(t => (
                  <span key={t} style={{ fontSize:12, fontFamily:G.mono, padding:"4px 10px", borderRadius:5, background:acid_dim, color:G.acid, border:`1px solid ${G.acid}22` }}>{t}</span>
                ))}
              </div>

              <SectionLabel>Job Description</SectionLabel>
              <div style={{ fontSize:13, color:G.t2, lineHeight:1.8 }}>
                <p style={{ marginBottom:12 }}>We're looking for a talented {selected.title} to join our growing engineering team. You'll be working on our core infrastructure, building systems that scale to millions of users and power the experiences our customers rely on.</p>
                <p style={{ marginBottom:12 }}>As part of the team, you'll take ownership of critical systems, collaborate closely with product and design, and contribute to architectural decisions that shape the direction of our platform.</p>
                <p><strong style={{ color:G.t1 }}>What you'll do:</strong></p>
                <ul style={{ paddingLeft:20, marginTop:8, display:"flex", flexDirection:"column", gap:6 }}>
                  <li>Design and build scalable backend services handling millions of requests</li>
                  <li>Own technical projects from design through deployment</li>
                  <li>Collaborate with cross-functional teams to define engineering standards</li>
                  <li>Mentor engineers and contribute to technical culture</li>
                </ul>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
};

/* ─── APPLICATIONS PAGE ──────────────────────────────────────────────── */
const ApplicationsPage = () => {
  const [activeTab, setActiveTab] = useState("all");
  const tabs = ["all","active","interviews","offers","rejected"];

  const filtered = APPLICATIONS.filter(a => {
    if(activeTab === "all")        return true;
    if(activeTab === "active")     return ["APPLIED","REVIEWING","FOLLOW_UP_SENT"].includes(a.status);
    if(activeTab === "interviews") return a.status === "INTERVIEW_SCHEDULED";
    if(activeTab === "offers")     return a.status === "OFFER_RECEIVED";
    if(activeTab === "rejected")   return ["REJECTED","WITHDRAWN"].includes(a.status);
    return true;
  });

  const funnelData = [
    { label:"Matched",   val:24, color:G.t3 },
    { label:"Applied",   val:7,  color:G.blue },
    { label:"Reviewing", val:3,  color:G.amber },
    { label:"Interview", val:4,  color:G.violet },
    { label:"Offer",     val:1,  color:G.acid },
  ];

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Applications</h1>
          <Mono color={G.t3}>7 active applications · bot applied 2 today</Mono>
        </div>
        <Btn small>+ Add manual</Btn>
      </div>

      {/* Funnel */}
      <Card style={{ marginBottom:16 }}>
        <div style={{ padding:"16px 20px" }}>
          <Mono color={G.t3} size={10}>APPLICATION FUNNEL</Mono>
          <div style={{ display:"flex", gap:0, marginTop:14, alignItems:"stretch" }}>
            {funnelData.map((f,i) => (
              <div key={f.label} style={{ flex:1, textAlign:"center", position:"relative" }}>
                <div style={{
                  height:40, background:`${f.color}22`, border:`1px solid ${f.color}44`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  borderRadius: i===0 ? "8px 0 0 8px" : i===funnelData.length-1 ? "0 8px 8px 0" : 0,
                  borderRight: i < funnelData.length-1 ? "none" : undefined,
                  marginRight: i < funnelData.length-1 ? 0 : 0,
                }}>
                  <span style={{ fontFamily:G.ui, fontSize:20, fontWeight:800, color:f.color }}>{f.val}</span>
                </div>
                <Mono color={G.t3} size={9} style={{ marginTop:6 }}>{f.label}</Mono>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div style={{ display:"flex", gap:2, borderBottom:`1px solid ${G.b1}`, marginBottom:16 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            padding:"8px 14px", fontFamily:G.mono, fontSize:10,
            letterSpacing:1, textTransform:"uppercase",
            color: activeTab===t ? G.acid : G.t3,
            background:"transparent", border:"none", cursor:"pointer",
            borderBottom:`2px solid ${activeTab===t ? G.acid : "transparent"}`,
            marginBottom:-1, transition:"all .15s",
          }}>{t}</button>
        ))}
      </div>

      <Card>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr style={{ background:G.s3 }}>
              {["Company","Role","Applied","Status","Follow-ups","Recruiter","Actions"].map(h => (
                <th key={h} style={{ padding:"9px 14px", textAlign:"left", fontFamily:G.mono, fontSize:10, letterSpacing:2, textTransform:"uppercase", color:G.t3, borderBottom:`1px solid ${G.b1}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(app => {
              const s = statusConfig[app.status];
              return (
                <tr key={app.id} style={{ borderBottom:`1px solid ${G.b1}`, cursor:"pointer", transition:"background .15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = G.s3}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ fontSize:18 }}>{app.logo}</span>
                      <span style={{ fontSize:13, fontWeight:600, color:G.t1 }}>{app.company}</span>
                    </div>
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ fontSize:13, color:G.t2, maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{app.title}</div>
                  </td>
                  <td style={{ padding:"12px 14px" }}><Mono color={G.t3}>{app.appliedAt}</Mono></td>
                  <td style={{ padding:"12px 14px" }}><Badge color={s.color} dim={s.dim} small>{s.label}</Badge></td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <div style={{ display:"flex", gap:3 }}>
                        {[1,2,3].map(n => (
                          <div key={n} style={{ width:8, height:8, borderRadius:"50%", background: n<=app.followUp ? G.violet : G.b2 }} />
                        ))}
                      </div>
                      <Mono color={G.t3}>{app.followUp}/3</Mono>
                    </div>
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <Mono color={G.t3}>{app.recruiter || "—"}</Mono>
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", gap:6 }}>
                      <button style={{ padding:"4px 8px", borderRadius:5, background:G.s4, border:`1px solid ${G.b2}`, fontSize:11, color:G.t3, cursor:"pointer", fontFamily:G.mono }}>View</button>
                      {app.status !== "REJECTED" && app.status !== "WITHDRAWN" && app.status !== "OFFER_RECEIVED" && (
                        <button style={{ padding:"4px 8px", borderRadius:5, background:vio_dim, border:`1px solid ${G.violet}33`, fontSize:11, color:G.violet, cursor:"pointer", fontFamily:G.mono }}>Prep</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

/* ─── INTERVIEW TRACKER PAGE ─────────────────────────────────────────── */
const InterviewsPage = () => {
  const [selected, setSelected] = useState(INTERVIEWS[0]);

  const typeConfig = {
    "Phone Screen":    { color:G.cyan,   dim:cyan_dim  },
    "Technical":       { color:G.blue,   dim:blue_dim  },
    "System Design":   { color:G.violet, dim:vio_dim   },
    "Final Round":     { color:G.acid,   dim:acid_dim  },
    "Behavioral":      { color:G.amber,  dim:amber_dim },
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Interviews</h1>
          <Mono color={G.t3}>4 upcoming · next in 2 days</Mono>
        </div>
        <Btn variant="secondary" small>+ Add interview</Btn>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"380px 1fr", gap:14 }}>
        {/* List */}
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {INTERVIEWS.map(iv => {
            const tc = typeConfig[iv.type] || { color:G.blue, dim:blue_dim };
            const isSelected = selected?.id === iv.id;
            return (
              <div key={iv.id} onClick={() => setSelected(iv)} style={{
                background: isSelected ? G.s3 : G.s2,
                border:`1px solid ${isSelected ? G.acid+"33" : G.b1}`,
                borderRadius:10, padding:"16px", cursor:"pointer",
                transition:"all .15s",
                borderLeft:`3px solid ${isSelected ? G.acid : tc.color}`,
              }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:22 }}>{iv.logo}</span>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color:G.t1 }}>{iv.company}</div>
                      <Mono color={G.t3} size={11}>{iv.title}</Mono>
                    </div>
                  </div>
                  <Badge color={tc.color} dim={tc.dim} small>{iv.type}</Badge>
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:8 }}>
                  <span style={{ fontSize:13, color:G.t2 }}>📅 {iv.date}</span>
                  <Mono color={G.t3}>·</Mono>
                  <Mono color={G.t3}>{iv.time}</Mono>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8 }}>
                  <Mono color={G.t3}>Round {iv.round} · {iv.platform}</Mono>
                  <Badge color={iv.status==="CONFIRMED"?G.acid:G.amber} dim={iv.status==="CONFIRMED"?acid_dim:amber_dim} small>{iv.status}</Badge>
                </div>
              </div>
            );
          })}
        </div>

        {/* Detail */}
        {selected && (
          <Card>
            <div style={{ padding:"24px 28px" }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:14, marginBottom:24 }}>
                <div style={{ fontSize:40 }}>{selected.logo}</div>
                <div style={{ flex:1 }}>
                  <h2 style={{ fontFamily:G.ui, fontSize:20, fontWeight:700, letterSpacing:-.5, color:G.t1 }}>{selected.title}</h2>
                  <div style={{ color:G.t2, fontSize:14, marginTop:2 }}>{selected.company}</div>
                </div>
                <Badge color={selected.status==="CONFIRMED"?G.acid:G.amber} dim={selected.status==="CONFIRMED"?acid_dim:amber_dim}>{selected.status}</Badge>
              </div>

              {/* Details grid */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:24 }}>
                {[
                  { l:"DATE", v:selected.date, icon:"📅" },
                  { l:"TIME", v:selected.time, icon:"🕐" },
                  { l:"TYPE", v:selected.type, icon:"📋" },
                  { l:"ROUND", v:`Round ${selected.round}`, icon:"🔄" },
                  { l:"PLATFORM", v:selected.platform, icon:"💻" },
                  { l:"INTERVIEWER", v:selected.interviewer, icon:"👤" },
                ].map(d => (
                  <div key={d.l} style={{ background:G.s3, borderRadius:8, padding:"12px 14px", display:"flex", gap:10 }}>
                    <span style={{ fontSize:16 }}>{d.icon}</span>
                    <div>
                      <Mono color={G.t3} size={9}>{d.l}</Mono>
                      <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginTop:2 }}>{d.v}</div>
                    </div>
                  </div>
                ))}
              </div>

              {selected.meetingLink && (
                <div style={{ background:blue_dim, border:`1px solid ${G.blue}33`, borderRadius:8, padding:"12px 16px", marginBottom:20, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <Mono color={G.blue} size={10}>MEETING LINK</Mono>
                    <div style={{ fontSize:12, color:G.blue, marginTop:3 }}>{selected.meetingLink}</div>
                  </div>
                  <Btn variant="secondary" small>Join ↗</Btn>
                </div>
              )}

              <SectionLabel>Interview Preparation</SectionLabel>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                <Btn variant="secondary" small>🎯 Generate prep guide</Btn>
                <Btn variant="secondary" small>📝 Tailor resume</Btn>
                <Btn variant="secondary" small>❓ Practice questions</Btn>
              </div>

              <div style={{ marginTop:24 }}>
                <SectionLabel>Pre-Interview Checklist</SectionLabel>
                {[
                  "Research latest news about "+selected.company,
                  "Test "+selected.platform+" setup 15 min before",
                  "Prepare 3 STAR stories relevant to "+selected.type,
                  "Review job description one more time",
                  "Prepare your 5 questions to ask",
                ].map((item,i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:`1px solid ${G.b1}` }}>
                    <div style={{ width:18, height:18, borderRadius:4, border:`1.5px solid ${G.b2}`, background:G.s3, flexShrink:0 }} />
                    <span style={{ fontSize:13, color:G.t2 }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
};

/* ─── FOLLOW-UPS PAGE ────────────────────────────────────────────────── */
const FollowupsPage = () => {
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Follow-up Emails</h1>
          <Mono color={G.t3}>3 sent this week · 2 pending recruiter reply</Mono>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn variant="secondary" small>Configure cadence</Btn>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:20 }}>
        {[
          { l:"SENT THIS WEEK", v:3, color:G.violet },
          { l:"RESPONSE RATE",  v:"43%", color:G.acid },
          { l:"AWAITING REPLY", v:2, color:G.amber },
          { l:"CANCELLED",      v:5, color:G.t3 },
        ].map(s => (
          <div key={s.l} style={{ background:G.s2, border:`1px solid ${G.b1}`, borderRadius:10, padding:"16px 18px" }}>
            <Mono color={G.t3} size={9}>{s.l}</Mono>
            <div style={{ fontFamily:G.ui, fontSize:26, fontWeight:800, letterSpacing:-1, color:s.color, marginTop:6 }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Timeline of follow-ups */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 340px", gap:14 }}>
        <Card>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${G.b1}` }}>
            <Mono color={G.t3} size={10}>FOLLOW-UP ACTIVITY</Mono>
          </div>
          <div style={{ padding:"20px 20px" }}>
            {/* Timeline */}
            {FOLLOW_UPS.map((fu, i) => (
              <div key={fu.id} style={{ display:"flex", gap:16, paddingBottom:20, position:"relative" }}>
                {i < FOLLOW_UPS.length-1 && (
                  <div style={{ position:"absolute", left:7, top:20, bottom:0, width:1, background:G.b1 }} />
                )}
                <div style={{
                  width:15, height:15, borderRadius:"50%", flexShrink:0, marginTop:2,
                  background:G.s2, border:`2px solid ${fu.status==="REPLIED" ? G.acid : G.violet}`,
                  position:"relative", zIndex:1,
                }} />
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginBottom:2 }}>
                        {fu.logo} {fu.company} — {fu.role}
                      </div>
                      <Mono color={G.t3}>Follow-up #{fu.followUpNum} · Sent {fu.sentAt}</Mono>
                    </div>
                    <Badge color={fu.status==="REPLIED"?G.acid:G.violet} dim={fu.status==="REPLIED"?acid_dim:vio_dim} small>
                      {fu.status}
                    </Badge>
                  </div>
                  <div style={{ marginTop:10, background:G.s3, borderRadius:8, padding:"12px 14px", border:`1px solid ${G.b2}` }}>
                    <Mono color={G.t3} size={9}>SUBJECT</Mono>
                    <div style={{ fontSize:12, color:G.t2, marginTop:4 }}>{fu.subject}</div>
                    {fu.recruiter && (
                      <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${G.b1}`, display:"flex", gap:6, alignItems:"center" }}>
                        <Mono color={G.t3} size={10}>To:</Mono>
                        <Mono color={G.t2} size={11}>{fu.recruiter} &lt;{fu.email}&gt;</Mono>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Schedule config */}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <Card>
            <div style={{ padding:"14px 16px", borderBottom:`1px solid ${G.b1}` }}>
              <Mono color={G.t3} size={10}>FOLLOW-UP SCHEDULE</Mono>
            </div>
            <div style={{ padding:"16px" }}>
              {[
                { day:3, label:"1st Follow-up", desc:"Warm check-in, restate interest", color:G.blue },
                { day:7, label:"2nd Follow-up", desc:"Value statement + soft ask", color:G.violet },
                { day:14, label:"Final Follow-up", desc:"Graceful close with opt-out", color:G.amber },
              ].map(f => (
                <div key={f.day} style={{ padding:"12px 0", borderBottom:`1px solid ${G.b1}` }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                    <span style={{ fontSize:13, fontWeight:600, color:G.t1 }}>{f.label}</span>
                    <span style={{ fontFamily:G.mono, fontSize:12, color:f.color }}>Day {f.day}</span>
                  </div>
                  <Mono color={G.t3}>{f.desc}</Mono>
                </div>
              ))}
              <div style={{ marginTop:14 }}>
                <Btn variant="secondary" small style={{ width:"100%", justifyContent:"center" }}>Edit schedule</Btn>
              </div>
            </div>
          </Card>

          <Card>
            <div style={{ padding:"14px 16px", borderBottom:`1px solid ${G.b1}` }}>
              <Mono color={G.t3} size={10}>AUTO-CANCEL TRIGGERS</Mono>
            </div>
            <div style={{ padding:"16px" }}>
              {["Recruiter replies","Interview scheduled","Rejection received","Offer received","Application withdrawn"].map(t => (
                <div key={t} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0" }}>
                  <div style={{ width:16, height:16, borderRadius:4, background:acid_dim, border:`1px solid ${G.acid}44`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <span style={{ color:G.acid, fontSize:9 }}>✓</span>
                  </div>
                  <span style={{ fontSize:12, color:G.t2 }}>{t}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

/* ─── NOTIFICATIONS PAGE ─────────────────────────────────────────────── */
const NotificationsPage = ({ onMarkRead }) => {
  const [filter, setFilter] = useState("all");

  const filtered = NOTIFICATIONS.filter(n =>
    filter === "all" ? true :
    filter === "unread" ? !n.read :
    n.type === filter
  );

  const typeFilters = ["all","unread","interview","offer","followup","match","rejection"];

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Notifications</h1>
          <Mono color={G.t3}>3 unread</Mono>
        </div>
        <Btn onClick={onMarkRead} variant="ghost" small>Mark all read</Btn>
      </div>

      {/* Filter chips */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:16 }}>
        {typeFilters.map(t => (
          <button key={t} onClick={() => setFilter(t)} style={{
            padding:"5px 12px", borderRadius:20, fontFamily:G.mono,
            fontSize:10, letterSpacing:1, textTransform:"uppercase",
            cursor:"pointer", transition:"all .15s",
            background: filter===t ? acid_dim : G.s2,
            color: filter===t ? G.acid : G.t3,
            border:`1px solid ${filter===t ? G.acid+"33" : G.b1}`,
          }}>{t}</button>
        ))}
      </div>

      <Card>
        {filtered.map(n => (
          <div key={n.id} style={{
            display:"flex", gap:14, padding:"14px 18px",
            borderBottom:`1px solid ${G.b1}`,
            background: !n.read ? `${n.color}08` : "transparent",
            cursor:"pointer", transition:"background .15s",
          }}
          onMouseEnter={e => e.currentTarget.style.background = G.s3}
          onMouseLeave={e => e.currentTarget.style.background = !n.read ? `${n.color}08` : "transparent"}>
            <div style={{
              width:38, height:38, borderRadius:9,
              background:`${n.color}18`, border:`1px solid ${n.color}33`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:18, flexShrink:0,
            }}>{n.icon}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:G.t1, marginBottom:3 }}>{n.title}</div>
              <div style={{ fontSize:12, color:G.t2, marginBottom:4, lineHeight:1.6 }}>{n.desc}</div>
              <Mono color={G.t3}>{n.time}</Mono>
            </div>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:8, flexShrink:0 }}>
              {!n.read && (
                <div style={{ width:7, height:7, borderRadius:"50%", background:G.acid }} />
              )}
              <button style={{ padding:"4px 10px", borderRadius:5, background:G.s4, border:`1px solid ${G.b2}`, fontSize:11, color:G.t3, cursor:"pointer", fontFamily:G.mono }}>View</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding:"48px 20px", textAlign:"center" }}>
            <div style={{ fontSize:32, marginBottom:12 }}>🔔</div>
            <div style={{ fontSize:14, color:G.t3 }}>No notifications matching this filter</div>
          </div>
        )}
      </Card>
    </div>
  );
};

/* ─── RESUME PAGE ────────────────────────────────────────────────────── */
const ResumePage = () => {
  const [dragging, setDragging] = useState(false);
  const [uploaded, setUploaded] = useState(true); // show parsed state by default
  const fileRef = useRef(null);

  const skills = [
    { cat:"Languages",    items:["TypeScript","Python","Go","Rust","SQL"] },
    { cat:"Frameworks",   items:["React","Next.js","Node.js","FastAPI","Django"] },
    { cat:"Cloud/Infra",  items:["AWS","Kubernetes","Docker","Terraform","Redis"] },
    { cat:"Databases",    items:["PostgreSQL","MongoDB","Elasticsearch","DynamoDB"] },
  ];

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Resume</h1>
          <Mono color={G.t3}>AI-parsed · 42 skills extracted · last updated Mar 10</Mono>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn variant="secondary" small>Download PDF</Btn>
          <Btn small>Upload new version</Btn>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 340px", gap:16 }}>
        {/* Left: resume preview or upload */}
        <div>
          {!uploaded ? (
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); setUploaded(true); }}
              onClick={() => fileRef.current?.click()}
              style={{
                border:`2px dashed ${dragging ? G.acid : G.b2}`,
                borderRadius:12, padding:"64px 32px",
                textAlign:"center", cursor:"pointer",
                background: dragging ? acid_dim : "transparent",
                transition:"all .2s",
              }}>
              <div style={{ fontSize:48, marginBottom:16 }}>📄</div>
              <div style={{ fontSize:16, fontWeight:600, color:G.t1, marginBottom:8 }}>Drop your resume here</div>
              <Mono color={G.t3}>PDF or DOCX · max 10MB</Mono>
              <input ref={fileRef} type="file" accept=".pdf,.docx" style={{ display:"none" }} onChange={() => setUploaded(true)}/>
            </div>
          ) : (
            <Card>
              <div style={{ padding:"20px 24px", borderBottom:`1px solid ${G.b1}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, color:G.t1 }}>Alex Johnson</div>
                  <Mono color={G.t3}>Senior Software Engineer · San Francisco, CA</Mono>
                </div>
                <Badge color={G.acid} dim={acid_dim}>Active</Badge>
              </div>

              {/* Contact */}
              <div style={{ padding:"16px 24px", borderBottom:`1px solid ${G.b1}`, display:"flex", gap:20, flexWrap:"wrap" }}>
                {["alex@example.com","github.com/alexj","linkedin.com/in/alexj"].map(c => (
                  <Mono key={c} color={G.t3} size={11}>{c}</Mono>
                ))}
              </div>

              {/* Summary */}
              <div style={{ padding:"16px 24px", borderBottom:`1px solid ${G.b1}` }}>
                <Mono color={G.t3} size={9}>SUMMARY</Mono>
                <p style={{ fontSize:13, color:G.t2, lineHeight:1.75, marginTop:8 }}>
                  Senior Software Engineer with 7+ years building scalable distributed systems. Expertise in TypeScript, Go, and PostgreSQL. Led teams of 5–8 engineers shipping features used by millions of users. Passionate about developer tooling, system performance, and engineering culture.
                </p>
              </div>

              {/* Experience */}
              <div style={{ padding:"16px 24px", borderBottom:`1px solid ${G.b1}` }}>
                <Mono color={G.t3} size={9}>EXPERIENCE</Mono>
                {[
                  { title:"Senior Software Engineer", co:"Shopify", period:"2021 – Present", bullets:["Led migration of order processing system to microservices, reducing latency by 40%","Built real-time inventory sync serving 1.2M merchants across 50+ countries","Mentored 4 junior engineers; ran bi-weekly architecture review sessions"] },
                  { title:"Software Engineer", co:"Segment (Twilio)", period:"2019 – 2021", bullets:["Owned the data pipeline ingesting 400B+ events/month","Reduced Kafka consumer lag by 78% through partition strategy rework"] },
                ].map(exp => (
                  <div key={exp.co} style={{ marginTop:16 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                      <div>
                        <div style={{ fontSize:13, fontWeight:700, color:G.t1 }}>{exp.title}</div>
                        <div style={{ fontSize:12, color:G.t2, marginTop:1 }}>{exp.co}</div>
                      </div>
                      <Mono color={G.t3}>{exp.period}</Mono>
                    </div>
                    <ul style={{ paddingLeft:18, marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                      {exp.bullets.map(b => (
                        <li key={b} style={{ fontSize:12, color:G.t2, lineHeight:1.6 }}>{b}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {/* Education */}
              <div style={{ padding:"16px 24px" }}>
                <Mono color={G.t3} size={9}>EDUCATION</Mono>
                <div style={{ marginTop:10, display:"flex", justifyContent:"space-between" }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600, color:G.t1 }}>B.S. Computer Science</div>
                    <Mono color={G.t3}>UC Berkeley</Mono>
                  </div>
                  <Mono color={G.t3}>2015 – 2019</Mono>
                </div>
              </div>
            </Card>
          )}
        </div>

        {/* Right: parsed skills + ATS */}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <Card>
            <div style={{ padding:"14px 16px", borderBottom:`1px solid ${G.b1}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <Mono color={G.t3} size={10}>PARSED SKILLS</Mono>
              <Mono color={G.acid} size={10}>42 total</Mono>
            </div>
            <div style={{ padding:"16px" }}>
              {skills.map(s => (
                <div key={s.cat} style={{ marginBottom:14 }}>
                  <Mono color={G.t3} size={9}>{s.cat.toUpperCase()}</Mono>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginTop:6 }}>
                    {s.items.map(item => (
                      <span key={item} style={{ fontSize:11, fontFamily:G.mono, padding:"3px 8px", borderRadius:4, background:acid_dim, color:G.acid, border:`1px solid ${G.acid}22` }}>{item}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div style={{ padding:"14px 16px", borderBottom:`1px solid ${G.b1}` }}>
              <Mono color={G.t3} size={10}>RESUME VERSIONS</Mono>
            </div>
            <div style={{ padding:"12px 16px" }}>
              {[
                { label:"Base Resume", date:"Mar 10", active:true },
                { label:"Tailored — Stripe", date:"Mar 10", active:false },
                { label:"Tailored — Vercel", date:"Mar 8",  active:false },
              ].map(v => (
                <div key={v.label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:`1px solid ${G.b1}` }}>
                  <div>
                    <div style={{ fontSize:13, color:G.t1, fontWeight: v.active ? 600 : 400 }}>{v.label}</div>
                    <Mono color={G.t3}>{v.date}</Mono>
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    {v.active && <Badge color={G.acid} dim={acid_dim} small>Active</Badge>}
                    <button style={{ fontSize:11, fontFamily:G.mono, padding:"3px 8px", borderRadius:5, background:G.s4, border:`1px solid ${G.b2}`, color:G.t3, cursor:"pointer" }}>View</button>
                  </div>
                </div>
              ))}
              <div style={{ marginTop:12 }}>
                <Btn variant="secondary" small style={{ width:"100%", justifyContent:"center" }}>+ Generate tailored version</Btn>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

/* ─── PREFERENCES PAGE ───────────────────────────────────────────────── */
const PreferencesPage = () => {
  const [autoApply, setAutoApply] = useState(true);
  const [minMatch, setMinMatch] = useState(75);
  const [maxApps, setMaxApps] = useState(10);
  const [roles, setRoles] = useState(["Senior Software Engineer","Staff Engineer","Principal Engineer"]);
  const [locations, setLocations] = useState(["Remote","San Francisco, CA","New York, NY"]);
  const [newRole, setNewRole] = useState("");
  const [newLoc, setNewLoc] = useState("");

  const addRole = () => { if(newRole.trim()) { setRoles([...roles, newRole.trim()]); setNewRole(""); }};
  const addLoc  = () => { if(newLoc.trim())  { setLocations([...locations, newLoc.trim()]); setNewLoc(""); }};

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:28 }}>
        <div>
          <h1 style={{ fontFamily:G.ui, fontSize:22, fontWeight:700, letterSpacing:-.6, color:G.t1 }}>Job Preferences</h1>
          <Mono color={G.t3}>Configure what the AI agent searches and applies to</Mono>
        </div>
        <Btn small>Save changes</Btn>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        {/* Target roles */}
        <Card>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${G.b1}` }}>
            <Mono size={10} color={G.t3}>TARGET ROLES</Mono>
          </div>
          <div style={{ padding:"18px" }}>
            <div style={{ display:"flex", gap:6, marginBottom:16 }}>
              <input value={newRole} onChange={e=>setNewRole(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addRole()} placeholder="Add job title…"
                style={{ flex:1, background:G.s3, border:`1px solid ${G.b2}`, borderRadius:7, padding:"8px 12px", fontFamily:G.ui, fontSize:13, color:G.t1, outline:"none" }}
                onFocus={e=>{e.target.style.borderColor=G.acid;}} onBlur={e=>{e.target.style.borderColor=G.b2;}}/>
              <Btn onClick={addRole} small>Add</Btn>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
              {roles.map(r => (
                <span key={r} style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:6, background:acid_dim, border:`1px solid ${G.acid}22`, fontSize:12, color:G.acid }}>
                  {r}
                  <span onClick={()=>setRoles(roles.filter(x=>x!==r))} style={{ cursor:"pointer", color:G.t3, fontSize:14, lineHeight:1 }}>×</span>
                </span>
              ))}
            </div>
          </div>
        </Card>

        {/* Preferred locations */}
        <Card>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${G.b1}` }}>
            <Mono size={10} color={G.t3}>PREFERRED LOCATIONS</Mono>
          </div>
          <div style={{ padding:"18px" }}>
            <div style={{ display:"flex", gap:6, marginBottom:16 }}>
              <input value={newLoc} onChange={e=>setNewLoc(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addLoc()} placeholder="Add location…"
                style={{ flex:1, background:G.s3, border:`1px solid ${G.b2}`, borderRadius:7, padding:"8px 12px", fontFamily:G.ui, fontSize:13, color:G.t1, outline:"none" }}
                onFocus={e=>{e.target.style.borderColor=G.acid;}} onBlur={e=>{e.target.style.borderColor=G.b2;}}/>
              <Btn onClick={addLoc} small>Add</Btn>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
              {locations.map(l => (
                <span key={l} style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:6, background:blue_dim, border:`1px solid ${G.blue}22`, fontSize:12, color:G.blue }}>
                  {l}
                  <span onClick={()=>setLocations(locations.filter(x=>x!==l))} style={{ cursor:"pointer", color:G.t3, fontSize:14, lineHeight:1 }}>×</span>
                </span>
              ))}
            </div>
          </div>
        </Card>

        {/* Auto-apply settings */}
        <Card>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${G.b1}` }}>
            <Mono size={10} color={G.t3}>AUTO-APPLY SETTINGS</Mono>
          </div>
          <div style={{ padding:"18px" }}>
            {/* Toggle */}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 0", borderBottom:`1px solid ${G.b1}`, marginBottom:16 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:G.t1 }}>Auto-apply enabled</div>
                <Mono color={G.t3}>Bot will apply to matched jobs automatically</Mono>
              </div>
              <div onClick={() => setAutoApply(!autoApply)} style={{
                width:44, height:24, borderRadius:12, cursor:"pointer",
                background: autoApply ? G.acid : G.s4,
                border:`1px solid ${autoApply ? G.acid : G.b2}`,
                position:"relative", transition:"all .2s",
              }}>
                <div style={{
                  position:"absolute", top:3, left: autoApply ? 23 : 3,
                  width:16, height:16, borderRadius:"50%",
                  background: autoApply ? G.bg : G.t3,
                  transition:"left .2s",
                }}/>
              </div>
            </div>

            {/* Min match score */}
            <div style={{ marginBottom:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <Mono color={G.t3} size={10}>MIN MATCH SCORE</Mono>
                <Mono color={G.acid} size={11}>{minMatch}%</Mono>
              </div>
              <input type="range" min={50} max={95} value={minMatch} onChange={e=>setMinMatch(Number(e.target.value))}
                style={{ width:"100%", appearance:"none", height:3, borderRadius:2, outline:"none", cursor:"pointer",
                  background:`linear-gradient(to right, ${G.acid} ${(minMatch-50)/45*100}%, ${G.s4} ${(minMatch-50)/45*100}%)` }}/>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
                <Mono color={G.t3} size={9}>50% (more jobs)</Mono>
                <Mono color={G.t3} size={9}>95% (best fit only)</Mono>
              </div>
            </div>

            {/* Max per day */}
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <Mono color={G.t3} size={10}>MAX APPLICATIONS / DAY</Mono>
                <Mono color={G.blue} size={11}>{maxApps}</Mono>
              </div>
              <input type="range" min={1} max={25} value={maxApps} onChange={e=>setMaxApps(Number(e.target.value))}
                style={{ width:"100%", appearance:"none", height:3, borderRadius:2, outline:"none", cursor:"pointer",
                  background:`linear-gradient(to right, ${G.blue} ${(maxApps-1)/24*100}%, ${G.s4} ${(maxApps-1)/24*100}%)` }}/>
            </div>
          </div>
        </Card>

        {/* Salary & seniority */}
        <Card>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${G.b1}` }}>
            <Mono size={10} color={G.t3}>COMPENSATION & SENIORITY</Mono>
          </div>
          <div style={{ padding:"18px" }}>
            <Input label="Minimum Salary" placeholder="e.g. $160,000" />
            <div style={{ marginBottom:18 }}>
              <Mono color={G.t3} size={10}>SENIORITY LEVEL</Mono>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginTop:8 }}>
                {["Mid","Senior","Staff","Principal","Director","Any"].map(s => (
                  <button key={s} style={{
                    padding:"7px 8px", borderRadius:6,
                    fontFamily:G.mono, fontSize:10, cursor:"pointer",
                    background: ["Senior","Staff"].includes(s) ? vio_dim : G.s3,
                    border:`1px solid ${["Senior","Staff"].includes(s) ? G.violet+"44" : G.b2}`,
                    color: ["Senior","Staff"].includes(s) ? G.violet : G.t3,
                    transition:"all .15s",
                  }}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <Mono color={G.t3} size={10}>EXCLUDED COMPANIES</Mono>
              <div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap" }}>
                {["FAANG (already applied)"].map(e => (
                  <span key={e} style={{ fontSize:11, fontFamily:G.mono, padding:"3px 8px", borderRadius:4, background:red_dim, color:G.red, border:`1px solid ${G.red}22` }}>{e} ×</span>
                ))}
                <span style={{ fontSize:11, fontFamily:G.mono, padding:"3px 8px", borderRadius:4, background:G.s4, color:G.t3, border:`1px solid ${G.b2}`, cursor:"pointer" }}>+ Add</span>
              </div>
            </div>
          </div>
        </Card>

        {/* Job sources */}
        <Card style={{ gridColumn:"span 2" }}>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${G.b1}` }}>
            <Mono size={10} color={G.t3}>JOB SOURCES — ACTIVE SCRAPERS</Mono>
          </div>
          <div style={{ padding:"18px", display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:10 }}>
            {[
              {name:"LinkedIn",    logo:"in",  active:true  },
              {name:"Indeed",      logo:"IN",  active:true  },
              {name:"Wellfound",   logo:"WF",  active:true  },
              {name:"Greenhouse",  logo:"GH",  active:true  },
              {name:"Lever",       logo:"LV",  active:true  },
              {name:"Workday",     logo:"WD",  active:false },
              {name:"Ashby",       logo:"AS",  active:true  },
              {name:"BambooHR",    logo:"BH",  active:false },
              {name:"SmartRecruit",logo:"SR",  active:false },
              {name:"Naukri",      logo:"NK",  active:false },
              {name:"Remotive",    logo:"RM",  active:false },
              {name:"AngelList",   logo:"AL",  active:false },
            ].map(src => (
              <div key={src.name} style={{
                background: src.active ? acid_dim : G.s3,
                border:`1px solid ${src.active ? G.acid+"33" : G.b1}`,
                borderRadius:8, padding:"10px 12px", textAlign:"center", cursor:"pointer",
                transition:"all .15s",
              }}>
                <div style={{ fontFamily:G.mono, fontSize:12, fontWeight:700, color:src.active?G.acid:G.t4, marginBottom:4 }}>{src.logo}</div>
                <Mono color={src.active?G.t2:G.t4} size={10}>{src.name}</Mono>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

/* ─── MAIN APP ───────────────────────────────────────────────────────── */
export default function App() {
  const [page, setPage] = useState("login");
  const [loggedIn, setLoggedIn] = useState(false);
  const [notifications, setNotifications] = useState(NOTIFICATIONS);
  const unread = notifications.filter(n => !n.read).length;

  const markAllRead = () => setNotifications(ns => ns.map(n => ({ ...n, read:true })));

  if (!loggedIn) {
    return (
      <>
        <FontLink />
        <style>{`
          * { box-sizing:border-box; margin:0; padding:0; }
          body { background:#050608; color:#edf2ff; font-family:'Bricolage Grotesque',system-ui,sans-serif; }
          @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
          input::placeholder { color:#4a5878; }
          input,button,select { font-family:inherit; }
        `}</style>
        <LoginPage onLogin={() => { setLoggedIn(true); setPage("dashboard"); }} />
      </>
    );
  }

  const renderPage = () => {
    switch(page) {
      case "dashboard":     return <DashboardPage onNav={setPage} />;
      case "jobs":          return <JobsPage />;
      case "applications":  return <ApplicationsPage />;
      case "interviews":    return <InterviewsPage />;
      case "followups":     return <FollowupsPage />;
      case "notifications": return <NotificationsPage onMarkRead={markAllRead} />;
      case "resume":        return <ResumePage />;
      case "preferences":   return <PreferencesPage />;
      default:              return <DashboardPage onNav={setPage} />;
    }
  };

  return (
    <>
      <FontLink />
      <style>{`
        * { box-sizing:border-box; margin:0; padding:0; }
        body { background:#050608; color:#edf2ff; font-family:'Bricolage Grotesque',system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:#232d40; border-radius:2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        input::placeholder { color:#4a5878; }
        input,button,select,textarea { font-family:inherit; }
        input[type=range] { -webkit-appearance:none; height:3px; border-radius:2px; outline:none; cursor:pointer; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; border-radius:50%; background:#00ff88; cursor:pointer; box-shadow:0 0 8px rgba(0,255,136,.4); }
      `}</style>

      <div style={{ display:"flex", flexDirection:"column", minHeight:"100vh" }}>
        <Topbar page={page} onNav={setPage} unread={unread} />
        <div style={{ display:"flex", flex:1 }}>
          <Sidebar page={page} onNav={setPage} unread={unread} />
          <div style={{
            flex:1, overflowY:"auto", padding:"28px 32px",
            background:G.bg, minHeight:"calc(100vh - 52px)",
          }}>
            {/* Ambient glow */}
            <div style={{
              position:"fixed", top:52, left:220, right:0, bottom:0,
              pointerEvents:"none", zIndex:0,
              background:`radial-gradient(ellipse 60% 40% at 15% 10%, rgba(0,255,136,.025) 0, transparent 60%),
                          radial-gradient(ellipse 50% 35% at 85% 80%, rgba(59,130,246,.025) 0, transparent 60%)`,
            }}/>
            <div style={{ position:"relative", zIndex:1, animation:"fadeUp .35s cubic-bezier(.16,1,.3,1) both" }} key={page}>
              {renderPage()}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
