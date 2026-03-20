// ══════════════════════════════════════════════════════════════
// Job Hunter AI — Marketing Landing Page
// Sections: Hero, How It Works, Features, Social Proof,
//           Pricing, FAQ, Footer
// ══════════════════════════════════════════════════════════════

"use client";
import { useState, useEffect, useRef } from "react";

// ── Design tokens ────────────────────────────────────────────
const C = {
  bg:     "#050608",
  s1:     "#0a0c10",
  s2:     "#0f1218",
  s3:     "#141820",
  b1:     "#1c2333",
  b2:     "#232d40",
  t1:     "#edf2ff",
  t2:     "#8898b8",
  t3:     "#4a5878",
  acid:   "#00ff88",
  blue:   "#3b82f6",
  amber:  "#f59e0b",
  red:    "#f43f5e",
  violet: "#8b5cf6",
  cyan:   "#06b6d4",
};

// ── Animated counter ─────────────────────────────────────────
function Counter({ end, suffix = "", duration = 2000 }) {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      obs.disconnect();
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        setVal(Math.floor(ease * end));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.5 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [end, duration]);
  return <span ref={ref}>{val.toLocaleString()}{suffix}</span>;
}

// ── Pill badge ────────────────────────────────────────────────
const Pill = ({ children, color = C.acid }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "4px 14px", borderRadius: 99,
    background: `${color}15`, border: `1px solid ${color}30`,
    color, fontSize: 12, fontFamily: "var(--mono)",
    letterSpacing: "1.5px", textTransform: "uppercase",
  }}>{children}</span>
);

// ── Section label ────────────────────────────────────────────
const SecLabel = ({ children }) => (
  <div style={{
    fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "3px",
    color: C.t3, textTransform: "uppercase",
    display: "flex", alignItems: "center", gap: 14, marginBottom: 14,
  }}>
    <div style={{ width: 24, height: 1, background: C.t3 }} />
    {children}
    <div style={{ flex: 1, height: 1, background: C.b1 }} />
  </div>
);

// ── Card ──────────────────────────────────────────────────────
const Card = ({ children, style = {} }) => (
  <div style={{
    background: C.s1, border: `1px solid ${C.b1}`,
    borderRadius: 12, padding: "24px 28px",
    ...style,
  }}>{children}</div>
);

// ── Main component ────────────────────────────────────────────
export default function LandingPage() {
  const [faqOpen, setFaqOpen] = useState(null);
  const [plan, setPlan] = useState("monthly");
  const [menuOpen, setMenuOpen] = useState(false);

  const PLANS = [
    {
      name: "Starter",
      monthly: 29, yearly: 19,
      color: C.t2,
      desc: "For casual job seekers",
      features: [
        "50 job applications / month",
        "AI match scoring",
        "Resume parsing",
        "Email follow-ups (3-step cadence)",
        "WhatsApp notifications",
        "5 interview prep kits / month",
      ],
      cta: "Start free trial",
    },
    {
      name: "Pro",
      monthly: 79, yearly: 55,
      color: C.acid,
      popular: true,
      desc: "For active job seekers",
      features: [
        "Unlimited applications",
        "Priority AI match scoring",
        "Auto resume tailoring per job",
        "Email follow-ups (custom cadence)",
        "Full interview prep + PDF export",
        "WhatsApp real-time alerts",
        "Analytics dashboard",
        "Proxy rotation (stealth mode)",
      ],
      cta: "Start free trial",
    },
    {
      name: "Agency",
      monthly: 299, yearly: 199,
      color: C.violet,
      desc: "For recruiters & outplacers",
      features: [
        "Up to 25 candidate profiles",
        "All Pro features per candidate",
        "Bulk resume processing",
        "Custom branding on PDFs",
        "Team dashboard",
        "API access",
        "Dedicated support",
        "SLA guarantee",
      ],
      cta: "Contact sales",
    },
  ];

  const FAQS = [
    {
      q: "Is applying automatically against job platform terms?",
      a: "We use human-like browser automation with randomized delays and residential proxies. Our bot mimics genuine user behaviour rather than API scraping. That said, you own the process — you review every application before it fires, and you can set strict match thresholds to ensure only relevant jobs are submitted.",
    },
    {
      q: "Which job platforms do you support?",
      a: "LinkedIn, Indeed, Wellfound (AngelList), Naukri, Greenhouse, Lever, Workday, Ashby, SmartRecruiters, BambooHR, and any company career page using a standard ATS. We add new platforms every sprint.",
    },
    {
      q: "How does the AI match score work?",
      a: "We score each job against your resume and preferences using Claude (Anthropic). The score weights: skills match 40%, experience level 30%, location / remote 20%, salary range 10%. You can adjust thresholds — e.g. only auto-apply to jobs scoring 80+.",
    },
    {
      q: "Can I review applications before they go out?",
      a: "Yes. You can run in 'review mode' where the bot prepares a tailored application and pauses for your approval. Or in 'auto mode' above a confidence threshold you set. You'll receive a WhatsApp ping for every submission.",
    },
    {
      q: "What happens to my resume data?",
      a: "Your resume is stored encrypted at rest (AES-256) in AWS S3. It's never shared with third parties. The AI processing uses Anthropic's API with zero-retention enabled — prompts are not used for training.",
    },
    {
      q: "Is there a free trial?",
      a: "Yes — 14 days free on any plan, no credit card required. You'll have full feature access. We'll send you a WhatsApp message on day 12 to remind you before the trial ends.",
    },
  ];

  const HOW = [
    { step: "01", title: "Upload your resume", desc: "Drop your PDF or Word doc. Our AI parses it in seconds — skills, experience, education, salary expectations extracted automatically.", icon: "📄" },
    { step: "02", title: "Set your preferences", desc: "Tell us what you want: roles, locations, salary range, seniority, company size. Toggle which job boards to search.", icon: "🎯" },
    { step: "03", title: "AI finds & scores jobs", desc: "Our scraper runs every 2 hours across all platforms. Every new listing gets an AI match score against your profile.", icon: "🔍" },
    { step: "04", title: "Bot applies for you", desc: "Above your match threshold, the bot fills and submits applications using a resume tailored to each specific job description.", icon: "🤖" },
    { step: "05", title: "AI follows up by email", desc: "3-step follow-up cadence: Day 3, 7, 14. Recruiters reply? Our AI reads their email and updates your application status automatically.", icon: "✉️" },
    { step: "06", title: "Get interview-ready", desc: "Interview scheduled? We generate a personalised prep kit: likely questions with STAR answers, company research, resume talking points.", icon: "🎤" },
  ];

  const TESTIMONIALS = [
    { name: "Priya M.", role: "Senior Engineer → Staff @ Stripe", stars: 5, text: "I set it up on a Sunday. By Wednesday I had 3 interviews. Got the Stripe offer in 3 weeks. The AI tailored cover letters were scarily good — recruiters specifically mentioned them." },
    { name: "James T.", role: "Product Manager → Director @ Figma", stars: 5, text: "Applied to 340 jobs in 6 weeks while working full time. I literally did nothing except review the applications it flagged. Hired in 8 weeks at 40% more than my old salary." },
    { name: "Ananya K.", role: "Bootcamp grad → SWE @ Shopify", stars: 5, text: "As a career switcher I was terrified. The interview prep kits were insane — it predicted 6 out of 8 questions I was actually asked. Offer in 5 weeks." },
    { name: "Marcus R.", role: "Outplaced → CTO @ YC startup", stars: 5, text: "Got laid off in January. Used this in February. Had 4 offers by March. The WhatsApp notifications for interview invites meant I never missed a fast-moving opportunity." },
  ];

  const styles = {
    root: {
      background: C.bg, color: C.t1, minHeight: "100vh",
      fontFamily: "Bricolage Grotesque, system-ui, sans-serif",
      overflowX: "hidden",
    },
    nav: {
      position: "sticky", top: 0, zIndex: 100,
      borderBottom: `1px solid ${C.b1}`,
      background: `${C.bg}ee`, backdropFilter: "blur(12px)",
      padding: "0 max(24px, 5vw)",
    },
    navInner: {
      maxWidth: 1200, margin: "0 auto",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      height: 60,
    },
    logo: {
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15,
      letterSpacing: "-0.5px", color: C.t1,
      display: "flex", alignItems: "center", gap: 8,
    },
    logoDot: { width: 8, height: 8, borderRadius: "50%", background: C.acid },
    navLinks: { display: "flex", gap: 32, listStyle: "none" },
    navLink: { fontSize: 13, color: C.t2, cursor: "pointer", transition: "color .15s" },
    wrap: { maxWidth: 1200, margin: "0 auto", padding: "0 max(24px, 5vw)" },
  };

  return (
    <div style={styles.root}>
      {/* ── Global font ─────────────────────────────────────── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&family=Geist+Mono:wght@400;500;600;700&display=swap');
        :root { --mono: 'Geist Mono', monospace; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::selection { background: ${C.acid}30; }
        a { color: inherit; text-decoration: none; }
        html { scroll-behavior: smooth; }
      `}</style>

      {/* ── Nav ───────────────────────────────────────────────── */}
      <nav style={styles.nav}>
        <div style={styles.navInner}>
          <div style={styles.logo}>
            <div style={styles.logoDot} />
            JOB HUNTER AI
          </div>
          <ul style={styles.navLinks}>
            {["Features","How it works","Pricing","FAQ"].map(l => (
              <li key={l}><a href={`#${l.toLowerCase().replace(" ","-")}`} style={styles.navLink}>{l}</a></li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 10 }}>
            <a href="/login" style={{ padding: "8px 18px", borderRadius: 8, border: `1px solid ${C.b2}`, fontSize: 13, color: C.t2, cursor: "pointer" }}>
              Sign in
            </a>
            <a href="/signup" style={{ padding: "8px 18px", borderRadius: 8, background: C.acid, color: "#000", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
              Start free trial
            </a>
          </div>
        </div>
      </nav>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section style={{ padding: "100px max(24px,5vw) 80px", position: "relative", overflow: "hidden" }}>
        {/* Background glow */}
        <div style={{ position: "absolute", top: "10%", left: "50%", transform: "translateX(-50%)", width: 600, height: 600, borderRadius: "50%", background: `radial-gradient(circle, ${C.acid}08 0%, transparent 70%)`, pointerEvents: "none" }} />

        <div style={{ ...styles.wrap, textAlign: "center", position: "relative" }}>
          <div style={{ marginBottom: 24 }}>
            <Pill>🤖 Fully autonomous job hunting</Pill>
          </div>
          <h1 style={{ fontSize: "clamp(40px,7vw,88px)", fontWeight: 800, lineHeight: 1.0, letterSpacing: "-4px", marginBottom: 28, color: C.t1 }}>
            Your AI agent applies<br />
            <span style={{ color: C.acid }}>while you sleep.</span>
          </h1>
          <p style={{ fontSize: "clamp(16px,2vw,22px)", color: C.t2, maxWidth: 600, margin: "0 auto 40px", lineHeight: 1.7 }}>
            Finds jobs, tailors your resume, submits applications, follows up with recruiters, and preps you for interviews. Fully automated.
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
            <a href="/signup" style={{ padding: "16px 36px", borderRadius: 10, background: C.acid, color: "#000", fontWeight: 800, fontSize: 16, cursor: "pointer", letterSpacing: "-0.3px" }}>
              Start for free — 14 days →
            </a>
            <a href="#how-it-works" style={{ padding: "16px 28px", borderRadius: 10, border: `1px solid ${C.b2}`, color: C.t2, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
              ▶ See how it works
            </a>
          </div>
          <p style={{ fontSize: 12, color: C.t3, marginTop: 16, fontFamily: "var(--mono)" }}>
            No credit card required · Cancel anytime
          </p>

          {/* Stats bar */}
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1,
            background: C.b1, borderRadius: 12, overflow: "hidden",
            marginTop: 80, border: `1px solid ${C.b1}`,
          }}>
            {[
              { n: 12400, s: "+", label: "Jobs applied" },
              { n: 87, s: "%", label: "Interview rate" },
              { n: 3.2, s: "wk", label: "Avg. time to offer" },
              { n: 2800, s: "+", label: "Hired users" },
            ].map(({ n, s, label }) => (
              <div key={label} style={{ background: C.s1, padding: "28px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "clamp(24px,3vw,40px)", fontWeight: 800, color: C.t1, letterSpacing: "-2px", fontFamily: "var(--mono)" }}>
                  <Counter end={typeof n === "number" ? Math.floor(n) : n} suffix={s} />
                </div>
                <div style={{ fontSize: 12, color: C.t3, marginTop: 6 }}>{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────── */}
      <section id="how-it-works" style={{ padding: "80px max(24px,5vw)" }}>
        <div style={styles.wrap}>
          <SecLabel>How it works</SecLabel>
          <h2 style={{ fontSize: "clamp(28px,4vw,48px)", fontWeight: 800, letterSpacing: "-2px", marginBottom: 12 }}>
            Six steps from resume to offer.
          </h2>
          <p style={{ color: C.t2, fontSize: 16, marginBottom: 56, maxWidth: 500, lineHeight: 1.7 }}>
            Set up in 10 minutes. The agent runs continuously in the background.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            {HOW.map(({ step, title, desc, icon }) => (
              <Card key={step} style={{ position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 16, right: 20, fontFamily: "var(--mono)", fontSize: 11, color: C.b2, letterSpacing: "2px" }}>{step}</div>
                <div style={{ fontSize: 32, marginBottom: 16 }}>{icon}</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: C.t1 }}>{title}</div>
                <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.7 }}>{desc}</div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────────── */}
      <section id="features" style={{ padding: "80px max(24px,5vw)", background: C.s1, borderTop: `1px solid ${C.b1}`, borderBottom: `1px solid ${C.b1}` }}>
        <div style={styles.wrap}>
          <SecLabel>Features</SecLabel>
          <h2 style={{ fontSize: "clamp(28px,4vw,48px)", fontWeight: 800, letterSpacing: "-2px", marginBottom: 56 }}>
            Everything a human recruiter does,<br />
            <span style={{ color: C.acid }}>but 24/7.</span>
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
            {[
              { icon: "🔍", title: "Multi-board scraping", desc: "LinkedIn, Indeed, Wellfound, Naukri, Greenhouse, Lever, Workday + more. 17 sources, every 2 hours.", color: C.blue },
              { icon: "🧠", title: "AI match scoring", desc: "Claude scores every job against your skills, experience, location, and salary. Only strong matches get submitted.", color: C.acid },
              { icon: "🤖", title: "Stealth bot application", desc: "Playwright automation with human-like delays, mouse jitter, proxy rotation. Beats detection on every major ATS.", color: C.violet },
              { icon: "📝", title: "Resume auto-tailoring", desc: "Each application gets a custom resume variant with keywords and framing matched to the specific JD.", color: C.amber },
              { icon: "✉️", title: "AI email follow-up", desc: "3-step cadence. When recruiters reply, Claude reads the email and automatically updates your application status.", color: C.cyan },
              { icon: "💬", title: "WhatsApp alerts", desc: "Interview invite? Offer received? You get an instant WhatsApp message with context — no app checking needed.", color: C.acid },
              { icon: "🎤", title: "Interview prep kits", desc: "30+ likely questions with STAR-format answers, company research brief, and resume talking points. Per interview.", color: C.red },
              { icon: "📊", title: "Application analytics", desc: "Funnel view from match to offer. Response rates by company, role, location. See what's working.", color: C.blue },
            ].map(({ icon, title, desc, color }) => (
              <div key={title} style={{
                background: C.s2, border: `1px solid ${C.b1}`, borderRadius: 12,
                padding: "24px 24px", transition: "border-color .2s",
              }}>
                <div style={{ fontSize: 28, marginBottom: 14 }}>{icon}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.t1, marginBottom: 8 }}>{title}</div>
                <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.7 }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Social proof ──────────────────────────────────────── */}
      <section style={{ padding: "80px max(24px,5vw)" }}>
        <div style={styles.wrap}>
          <SecLabel>Results</SecLabel>
          <h2 style={{ fontSize: "clamp(28px,4vw,48px)", fontWeight: 800, letterSpacing: "-2px", marginBottom: 48 }}>
            Real hires. Real numbers.
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
            {TESTIMONIALS.map(({ name, role, text, stars }) => (
              <Card key={name}>
                <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
                  {Array(stars).fill(0).map((_, i) => (
                    <span key={i} style={{ color: C.amber, fontSize: 14 }}>★</span>
                  ))}
                </div>
                <p style={{ fontSize: 14, color: C.t2, lineHeight: 1.75, marginBottom: 20 }}>"{text}"</p>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.t1 }}>{name}</div>
                  <div style={{ fontSize: 11, color: C.acid, fontFamily: "var(--mono)", marginTop: 3 }}>{role}</div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────── */}
      <section id="pricing" style={{ padding: "80px max(24px,5vw)", background: C.s1, borderTop: `1px solid ${C.b1}`, borderBottom: `1px solid ${C.b1}` }}>
        <div style={{ ...styles.wrap, textAlign: "center" }}>
          <SecLabel>Pricing</SecLabel>
          <h2 style={{ fontSize: "clamp(28px,4vw,48px)", fontWeight: 800, letterSpacing: "-2px", marginBottom: 12 }}>
            Simple, transparent pricing.
          </h2>
          <p style={{ color: C.t2, marginBottom: 36, fontSize: 15 }}>14-day free trial. No credit card required.</p>
          {/* Toggle */}
          <div style={{ display: "inline-flex", background: C.s2, border: `1px solid ${C.b2}`, borderRadius: 8, padding: 4, marginBottom: 48, gap: 4 }}>
            {["monthly","yearly"].map(p => (
              <button key={p} onClick={() => setPlan(p)} style={{
                padding: "8px 24px", borderRadius: 6, border: "none", cursor: "pointer",
                background: plan === p ? C.acid : "transparent",
                color: plan === p ? "#000" : C.t2,
                fontWeight: plan === p ? 700 : 400,
                fontSize: 13, transition: "all .15s",
                fontFamily: "inherit",
              }}>
                {p === "monthly" ? "Monthly" : "Yearly (save 30%)"}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, textAlign: "left" }}>
            {PLANS.map(({ name, monthly, yearly, color, popular, desc, features, cta }) => {
              const price = plan === "monthly" ? monthly : yearly;
              return (
                <div key={name} style={{
                  background: popular ? `linear-gradient(145deg, ${C.s2}, ${C.s3})` : C.s2,
                  border: `1.5px solid ${popular ? C.acid : C.b1}`,
                  borderRadius: 14, padding: "28px 28px 24px",
                  position: "relative", overflow: "hidden",
                }}>
                  {popular && (
                    <div style={{ position: "absolute", top: 16, right: 16 }}>
                      <Pill color={C.acid}>Most popular</Pill>
                    </div>
                  )}
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: C.t3, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 8 }}>{name}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 6 }}>
                    <span style={{ fontSize: 46, fontWeight: 800, color: C.t1, letterSpacing: "-2px" }}>${price}</span>
                    <span style={{ color: C.t3, fontSize: 13 }}>/mo</span>
                  </div>
                  <p style={{ fontSize: 13, color: C.t3, marginBottom: 24 }}>{desc}</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
                    {features.map(f => (
                      <div key={f} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span style={{ color: color, flexShrink: 0, fontSize: 14, marginTop: 1 }}>✓</span>
                        <span style={{ fontSize: 13, color: C.t2, lineHeight: 1.5 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                  <a href="/signup" style={{
                    display: "block", textAlign: "center",
                    padding: "12px 0", borderRadius: 8,
                    background: popular ? C.acid : "transparent",
                    border: `1.5px solid ${popular ? C.acid : C.b2}`,
                    color: popular ? "#000" : C.t2,
                    fontWeight: 700, fontSize: 14, cursor: "pointer",
                    transition: "all .15s",
                  }}>{cta}</a>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────────── */}
      <section id="faq" style={{ padding: "80px max(24px,5vw)" }}>
        <div style={{ ...styles.wrap, maxWidth: 760 }}>
          <SecLabel>FAQ</SecLabel>
          <h2 style={{ fontSize: "clamp(28px,4vw,40px)", fontWeight: 800, letterSpacing: "-2px", marginBottom: 40 }}>Common questions</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {FAQS.map(({ q, a }, i) => (
              <div key={i} style={{ background: C.s1, border: `1px solid ${faqOpen === i ? C.acid + "40" : C.b1}`, borderRadius: 10, overflow: "hidden", transition: "border-color .2s" }}>
                <button onClick={() => setFaqOpen(faqOpen === i ? null : i)} style={{
                  width: "100%", textAlign: "left", padding: "18px 22px",
                  background: "none", border: "none", cursor: "pointer", color: C.t1,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  fontSize: 15, fontWeight: 600, fontFamily: "inherit", gap: 16,
                }}>
                  {q}
                  <span style={{ color: C.t3, fontSize: 20, flexShrink: 0, transition: "transform .2s", transform: faqOpen === i ? "rotate(45deg)" : "none" }}>+</span>
                </button>
                {faqOpen === i && (
                  <div style={{ padding: "0 22px 18px", fontSize: 14, color: C.t2, lineHeight: 1.8 }}>{a}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA banner ────────────────────────────────────────── */}
      <section style={{ padding: "60px max(24px,5vw)", background: C.s1, borderTop: `1px solid ${C.b1}` }}>
        <div style={{ ...styles.wrap, textAlign: "center" }}>
          <h2 style={{ fontSize: "clamp(28px,4vw,52px)", fontWeight: 800, letterSpacing: "-2px", marginBottom: 16 }}>
            Ready to let AI find your next job?
          </h2>
          <p style={{ color: C.t2, fontSize: 16, marginBottom: 36 }}>14-day free trial. No card needed. Cancel any time.</p>
          <a href="/signup" style={{ padding: "18px 48px", borderRadius: 10, background: C.acid, color: "#000", fontWeight: 800, fontSize: 18, cursor: "pointer", letterSpacing: "-0.3px", display: "inline-block" }}>
            Start applying automatically →
          </a>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer style={{ padding: "48px max(24px,5vw) 32px", borderTop: `1px solid ${C.b1}` }}>
        <div style={{ ...styles.wrap, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 40 }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 14, color: C.t1, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.acid }} />
              JOB HUNTER AI
            </div>
            <p style={{ fontSize: 13, color: C.t3, lineHeight: 1.7, maxWidth: 240 }}>
              Autonomous AI agent for job seekers. Find, apply, follow up, and prepare — all on autopilot.
            </p>
          </div>
          {[
            { heading: "Product", links: ["Features", "How it works", "Pricing", "Changelog"] },
            { heading: "Company", links: ["About", "Blog", "Careers", "Contact"] },
            { heading: "Legal", links: ["Privacy", "Terms", "Security", "GDPR"] },
          ].map(({ heading, links }) => (
            <div key={heading}>
              <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: C.t3, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 14 }}>{heading}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {links.map(l => <a key={l} href="#" style={{ fontSize: 13, color: C.t3, cursor: "pointer" }}>{l}</a>)}
              </div>
            </div>
          ))}
        </div>
        <div style={{ ...styles.wrap, borderTop: `1px solid ${C.b1}`, marginTop: 40, paddingTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: C.t3, fontFamily: "var(--mono)" }}>© 2025 Job Hunter AI. All rights reserved.</span>
          <span style={{ fontSize: 12, color: C.t3 }}>Built with Claude · Powered by Playwright · Secured by AWS</span>
        </div>
      </footer>
    </div>
  );
}
