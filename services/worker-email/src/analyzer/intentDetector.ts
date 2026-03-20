// ============================================================
// Intent Detector
// Fast two-pass heuristic detection before Claude.
// Returns a ResponseIntent with confidence score.
// Claude only runs when confidence < CLAUDE_THRESHOLD.
//
// Pass 1: Signal-weighted pattern matching
//   Each signal pattern is weighted 1–5.
//   First intent to exceed CONFIRM_THRESHOLD wins.
//
// Pass 2: Composite scoring across all intents.
//   Picks highest scorer if no clear winner.
// ============================================================

import type { ResponseIntent } from './analyzerTypes.js';

export interface IntentScore {
  intent:     ResponseIntent;
  score:      number;           // Raw signal score
  confidence: number;           // 0–1 normalised
  signals:    string[];         // Which patterns fired
}

// ── Threshold at which we trust the heuristic ─────────────────
const CONFIRM_THRESHOLD = 12;   // Score above this → skip Claude
const CLAUDE_THRESHOLD  = 6;    // Score below this → definitely use Claude

// ── Signal definitions ────────────────────────────────────────
interface Signal {
  pattern:    RegExp;
  weight:     number;    // 1–5
  label:      string;
}

const SIGNALS: Record<ResponseIntent, Signal[]> = {

  interview_scheduled: [
    { pattern: /your interview (is|has been) (scheduled|confirmed|set)/i,           weight: 5, label: 'explicit_confirm' },
    { pattern: /we('re| are| have) (scheduled|confirmed|booked) (a |an )?interview/i, weight: 5, label: 'we_scheduled' },
    { pattern: /interview (is|has been) (confirmed|booked|set up)/i,                weight: 5, label: 'confirmed' },
    { pattern: /(?:you are|you're) (scheduled|booked|confirmed)/i,                  weight: 4, label: 'you_are_scheduled' },
    { pattern: /(?:meeting|call|interview) (details|information) below/i,           weight: 4, label: 'details_below' },
    { pattern: /(?:zoom|meet\.google|teams|webex)\.com\/[a-z0-9/]+/i,              weight: 3, label: 'video_link' },
    { pattern: /\d{1,2}:\d{2}\s*(am|pm)\s+[A-Z]{2,4}/i,                           weight: 3, label: 'explicit_time_tz' },
    { pattern: /dial-in|conference id|passcode|pin:/i,                             weight: 3, label: 'dial_in' },
    { pattern: /add (this|the) (event|meeting|appointment) to your calendar/i,     weight: 3, label: 'add_to_calendar' },
    { pattern: /calendar invitation/i,                                              weight: 3, label: 'cal_invite' },
  ],

  interview_request: [
    { pattern: /would you (be available|like to|mind) (for |to )(schedule|set up|have|hop on)/i, weight: 5, label: 'would_you' },
    { pattern: /we('d| would) (like|love) to (schedule|set up|have|invite you)/i,               weight: 5, label: 'wed_like' },
    { pattern: /are you (available|free|open) (for |to )(a |an )?(call|interview|chat|meeting)/i, weight: 5, label: 'are_you_available' },
    { pattern: /invite you (to|for) (an? )?(interview|call|chat|screening)/i,                   weight: 5, label: 'invite_you' },
    { pattern: /next step(s)? (?:is|would be|involves?) (?:a |an )?(call|interview|screen)/i,   weight: 4, label: 'next_step_call' },
    { pattern: /(phone|video|technical|onsite|screening) (screen|interview|call)/i,              weight: 3, label: 'interview_type' },
    { pattern: /let(?:'s| us) (find|identify|settle on) (a |an )?(time|slot|date)/i,            weight: 3, label: 'find_time' },
    { pattern: /impressed (with|by) your (background|experience|profile|resume)/i,              weight: 2, label: 'impressed' },
    { pattern: /move(d)? (forward|ahead|to the next stage)/i,                                   weight: 3, label: 'move_forward' },
  ],

  availability_request: [
    { pattern: /(?:share|send|provide|let us know) your availability/i,              weight: 5, label: 'share_availability' },
    { pattern: /(?:what|which) times? (work|are convenient|suit) (for |you)/i,       weight: 5, label: 'what_times_work' },
    { pattern: /when (?:are you|would you be) (?:available|free)/i,                  weight: 5, label: 'when_available' },
    { pattern: /please (respond|reply|let us know) with.*availab/i,                  weight: 4, label: 'respond_with_avail' },
    { pattern: /(?:a few|some) time(s| slots?) that work for you/i,                  weight: 4, label: 'slots_for_you' },
    { pattern: /(?:calendly|cal\.com|savvycal)/i,                                    weight: 3, label: 'scheduling_link' },
    { pattern: /doodle\.com\/poll/i,                                                 weight: 3, label: 'doodle_poll' },
    { pattern: /book (?:a time|an appointment|a slot)/i,                             weight: 3, label: 'book_time' },
  ],

  calendar_link_sent: [
    { pattern: /(?:use|book|click|schedule) (?:via |using |through |on )?(?:this |my |the )?(?:link|calendar)/i, weight: 4, label: 'use_link' },
    { pattern: /calendly\.com\//i,                                                   weight: 5, label: 'calendly' },
    { pattern: /cal\.com\//i,                                                        weight: 5, label: 'cal_com' },
    { pattern: /savvycal\.com\//i,                                                   weight: 5, label: 'savvycal' },
    { pattern: /hubspot.*meetings\//i,                                               weight: 5, label: 'hubspot_meeting' },
    { pattern: /pick a (time|slot) that works for you/i,                             weight: 3, label: 'pick_time' },
  ],

  request_for_information: [
    { pattern: /(?:could you|please|kindly) (?:send|provide|share|attach|forward|submit)/i, weight: 4, label: 'please_send' },
    { pattern: /(?:we need|we require|we are requesting|could we get)/i,                    weight: 4, label: 'we_need' },
    { pattern: /(?:reference|portfolio|writing sample|work sample|transcript|certificate)/i, weight: 3, label: 'doc_type' },
    { pattern: /background (check|verification)/i,                                          weight: 4, label: 'bg_check' },
    { pattern: /before (?:we|the interview|moving forward)/i,                               weight: 3, label: 'before_we' },
    { pattern: /can you (?:tell us|share|explain|elaborate|walk us through)/i,              weight: 2, label: 'can_you_explain' },
    { pattern: /(?:additional|further|more) (?:information|details|documentation|info)/i,  weight: 3, label: 'more_info' },
  ],

  offer_extended: [
    { pattern: /(?:pleased|delighted|excited|happy) to (offer|extend|present)/i,   weight: 5, label: 'pleased_to_offer' },
    { pattern: /formal (offer|employment) letter/i,                                 weight: 5, label: 'formal_offer' },
    { pattern: /offer letter (?:attached|enclosed|below|inside)/i,                 weight: 5, label: 'offer_letter' },
    { pattern: /(?:welcome|join) (?:to |the )?(?:our )?team/i,                     weight: 4, label: 'welcome_to_team' },
    { pattern: /starting (?:salary|compensation|pay)/i,                            weight: 4, label: 'starting_salary' },
    { pattern: /we('d| would) like to (offer|extend|make) you/i,                   weight: 5, label: 'wed_like_to_offer' },
    { pattern: /employment (agreement|contract|terms)/i,                           weight: 4, label: 'employment_agreement' },
  ],

  moved_to_next_stage: [
    { pattern: /advance(?:d|ing) you to (?:the )?next (?:stage|round|step)/i,      weight: 5, label: 'advanced' },
    { pattern: /move(?:d|ing) forward with your (?:application|candidacy)/i,       weight: 5, label: 'moving_forward' },
    { pattern: /shortlisted|selected for the next/i,                               weight: 5, label: 'shortlisted' },
    { pattern: /(?:we are|we're) (?:happy|pleased|excited) to (invite|move)/i,     weight: 4, label: 'happy_to_invite' },
    { pattern: /next (?:phase|stage|round) of (?:our|the) (?:process|hiring)/i,    weight: 4, label: 'next_phase' },
  ],

  assessment_sent: [
    { pattern: /(?:technical|coding) (?:assessment|challenge|test|exercise)/i,     weight: 5, label: 'coding_test' },
    { pattern: /take-?home (?:assignment|assessment|project|test)/i,                weight: 5, label: 'take_home' },
    { pattern: /hackerrank|codility|coderpad|leetcode|testgorilla|greenhouse.*test/i, weight: 5, label: 'test_platform' },
    { pattern: /complete (the|this|a|an) (?:assessment|test|challenge|task)/i,     weight: 5, label: 'complete_test' },
    { pattern: /(?:due|complete by|submit by|deadline)/i,                          weight: 2, label: 'deadline' },
    { pattern: /\d+ (?:hours?|days?) to complete/i,                                weight: 4, label: 'time_limit' },
  ],

  rejection: [
    { pattern: /(?:not|no longer) (?:moving forward|proceeding|advancing)/i,       weight: 5, label: 'not_moving' },
    { pattern: /position (?:has been|is) filled/i,                                 weight: 5, label: 'filled' },
    { pattern: /decided (?:not to|to move forward with other|to go with another)/i, weight: 5, label: 'decided_not_to' },
    { pattern: /we regret to (?:inform|let you know|tell you)/i,                   weight: 5, label: 'regret_to_inform' },
    { pattern: /unfortunately(?:.{0,80})(application|candidacy|profile)/i,         weight: 4, label: 'unfortunately' },
    { pattern: /not (?:a fit|the right fit|what we(?:'re| are) looking for)/i,     weight: 5, label: 'not_a_fit' },
    { pattern: /best of luck (?:in your|with your|on your) (?:search|job search|future)/i, weight: 4, label: 'best_of_luck' },
  ],

  rejection_soft: [
    { pattern: /keep (?:your|the) (?:resume|cv|profile) on file/i,                 weight: 5, label: 'on_file' },
    { pattern: /right now|at this time|currently/i,                                weight: 2, label: 'timing' },
    { pattern: /(?:revisit|reach out) in (?:the future|a few months|6 months)/i,   weight: 5, label: 'revisit_future' },
    { pattern: /not the right (?:time|fit) (?:at this moment|currently)/i,         weight: 5, label: 'not_right_now' },
    { pattern: /(?:circumstances|priorities|budget|headcount) (?:change|changes)/i, weight: 3, label: 'circumstances' },
    { pattern: /pipeline|future (?:roles?|openings?|opportunities?)/i,             weight: 3, label: 'pipeline' },
  ],

  auto_reply: [
    { pattern: /out of (?:the )?office/i,                                           weight: 5, label: 'ooo' },
    { pattern: /(?:automatic|auto).?reply/i,                                        weight: 5, label: 'auto_reply' },
    { pattern: /away from (?:my )?(?:desk|office|email)/i,                         weight: 5, label: 'away' },
    { pattern: /will (?:be )?(?:back|return) on/i,                                  weight: 4, label: 'back_on' },
    { pattern: /this (?:message|email) was sent automatically/i,                   weight: 5, label: 'automated' },
    { pattern: /do not (?:reply|respond) to this (?:email|message)/i,              weight: 5, label: 'do_not_reply' },
    { pattern: /noreply@|no-reply@|donotreply@/i,                                  weight: 5, label: 'noreply_addr' },
  ],

  unclassified: [],
};

// ─────────────────────────────────────────────────────────────
// MAIN DETECTOR
// ─────────────────────────────────────────────────────────────
export function detectIntent(text: string): {
  top: IntentScore;
  all: IntentScore[];
  needsClaude: boolean;
} {
  const combined = text.toLowerCase();
  const scored: IntentScore[] = [];

  for (const [intent, signals] of Object.entries(SIGNALS) as [ResponseIntent, Signal[]][]) {
    let score = 0;
    const fired: string[] = [];

    for (const sig of signals) {
      if (sig.pattern.test(combined)) {
        score += sig.weight;
        fired.push(sig.label);
      }
    }

    if (score > 0) {
      scored.push({
        intent,
        score,
        confidence: Math.min(0.99, 0.4 + score * 0.06),
        signals:    fired,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0] ?? { intent: 'unclassified' as ResponseIntent, score: 0, confidence: 0.3, signals: [] };

  return {
    top,
    all:         scored,
    needsClaude: top.score < CLAUDE_THRESHOLD,
  };
}
