/**
 * WCAG 2.2 success-criterion catalog — deterministic reference data shared by
 * every service. `WcagSc` is a closed enum: an LLM cannot "invent" SC 9.9.9,
 * because tool-call arguments are parsed against this enum before use.
 *
 * `appliesTo` lists the element kinds a criterion can meaningfully apply to.
 * The verifier uses it to reject findings whose cited criterion does not fit
 * the element the snippet points at (e.g. 3.1.1 Language of Page on a <button>).
 */
import { z } from "zod";

export const ELEMENT_KINDS = [
  "img", "media", "link", "button", "form-control", "heading", "document",
  "frame", "table", "list", "landmark", "interactive", "style", "text",
] as const;
export const ElementKind = z.enum(ELEMENT_KINDS);
export type ElementKind = z.infer<typeof ElementKind>;

export type WcagLevel = "A" | "AA" | "AAA";
export interface ScInfo {
  title: string;
  level: WcagLevel;
  /** "any" = no structural restriction can be checked statically */
  appliesTo: readonly ElementKind[] | "any";
}

const ctl = ["link", "button", "form-control", "interactive"] as const;

export const WCAG_22 = {
  "1.1.1": { title: "Non-text Content", level: "A", appliesTo: ["img", "media", "button", "link"] },
  "1.2.1": { title: "Audio-only and Video-only (Prerecorded)", level: "A", appliesTo: ["media"] },
  "1.2.2": { title: "Captions (Prerecorded)", level: "A", appliesTo: ["media"] },
  "1.2.3": { title: "Audio Description or Media Alternative (Prerecorded)", level: "A", appliesTo: ["media"] },
  "1.2.4": { title: "Captions (Live)", level: "AA", appliesTo: ["media"] },
  "1.2.5": { title: "Audio Description (Prerecorded)", level: "AA", appliesTo: ["media"] },
  "1.2.6": { title: "Sign Language (Prerecorded)", level: "AAA", appliesTo: ["media"] },
  "1.2.7": { title: "Extended Audio Description (Prerecorded)", level: "AAA", appliesTo: ["media"] },
  "1.2.8": { title: "Media Alternative (Prerecorded)", level: "AAA", appliesTo: ["media"] },
  "1.2.9": { title: "Audio-only (Live)", level: "AAA", appliesTo: ["media"] },
  "1.3.1": { title: "Info and Relationships", level: "A", appliesTo: "any" },
  "1.3.2": { title: "Meaningful Sequence", level: "A", appliesTo: "any" },
  "1.3.3": { title: "Sensory Characteristics", level: "A", appliesTo: "any" },
  "1.3.4": { title: "Orientation", level: "AA", appliesTo: ["style", "document"] },
  "1.3.5": { title: "Identify Input Purpose", level: "AA", appliesTo: ["form-control"] },
  "1.3.6": { title: "Identify Purpose", level: "AAA", appliesTo: "any" },
  "1.4.1": { title: "Use of Color", level: "A", appliesTo: "any" },
  "1.4.2": { title: "Audio Control", level: "A", appliesTo: ["media"] },
  "1.4.3": { title: "Contrast (Minimum)", level: "AA", appliesTo: ["style", "text", "link", "button", "heading", "form-control"] },
  "1.4.4": { title: "Resize Text", level: "AA", appliesTo: ["document", "style"] },
  "1.4.5": { title: "Images of Text", level: "AA", appliesTo: ["img"] },
  "1.4.6": { title: "Contrast (Enhanced)", level: "AAA", appliesTo: ["style", "text", "link", "button", "heading", "form-control"] },
  "1.4.7": { title: "Low or No Background Audio", level: "AAA", appliesTo: ["media"] },
  "1.4.8": { title: "Visual Presentation", level: "AAA", appliesTo: ["style", "text", "document"] },
  "1.4.9": { title: "Images of Text (No Exception)", level: "AAA", appliesTo: ["img"] },
  "1.4.10": { title: "Reflow", level: "AA", appliesTo: ["style", "document"] },
  "1.4.11": { title: "Non-text Contrast", level: "AA", appliesTo: ["style", "button", "form-control", "img", "link"] },
  "1.4.12": { title: "Text Spacing", level: "AA", appliesTo: ["style", "document"] },
  "1.4.13": { title: "Content on Hover or Focus", level: "AA", appliesTo: "any" },
  "2.1.1": { title: "Keyboard", level: "A", appliesTo: ctl },
  "2.1.2": { title: "No Keyboard Trap", level: "A", appliesTo: ctl },
  "2.1.3": { title: "Keyboard (No Exception)", level: "AAA", appliesTo: ctl },
  "2.1.4": { title: "Character Key Shortcuts", level: "A", appliesTo: "any" },
  "2.2.1": { title: "Timing Adjustable", level: "A", appliesTo: "any" },
  "2.2.2": { title: "Pause, Stop, Hide", level: "A", appliesTo: "any" },
  "2.2.3": { title: "No Timing", level: "AAA", appliesTo: "any" },
  "2.2.4": { title: "Interruptions", level: "AAA", appliesTo: "any" },
  "2.2.5": { title: "Re-authenticating", level: "AAA", appliesTo: "any" },
  "2.2.6": { title: "Timeouts", level: "AAA", appliesTo: "any" },
  "2.3.1": { title: "Three Flashes or Below Threshold", level: "A", appliesTo: "any" },
  "2.3.2": { title: "Three Flashes", level: "AAA", appliesTo: "any" },
  "2.3.3": { title: "Animation from Interactions", level: "AAA", appliesTo: ["style", "interactive"] },
  "2.4.1": { title: "Bypass Blocks", level: "A", appliesTo: ["document", "link", "landmark"] },
  "2.4.2": { title: "Page Titled", level: "A", appliesTo: ["document"] },
  "2.4.3": { title: "Focus Order", level: "A", appliesTo: ctl },
  "2.4.4": { title: "Link Purpose (In Context)", level: "A", appliesTo: ["link"] },
  "2.4.5": { title: "Multiple Ways", level: "AA", appliesTo: ["document", "landmark", "link"] },
  "2.4.6": { title: "Headings and Labels", level: "AA", appliesTo: ["heading", "form-control"] },
  "2.4.7": { title: "Focus Visible", level: "AA", appliesTo: ["style", ...ctl] },
  "2.4.8": { title: "Location", level: "AAA", appliesTo: ["document", "landmark", "link"] },
  "2.4.9": { title: "Link Purpose (Link Only)", level: "AAA", appliesTo: ["link"] },
  "2.4.10": { title: "Section Headings", level: "AAA", appliesTo: ["heading", "document"] },
  "2.4.11": { title: "Focus Not Obscured (Minimum)", level: "AA", appliesTo: ["style", ...ctl] },
  "2.4.12": { title: "Focus Not Obscured (Enhanced)", level: "AAA", appliesTo: ["style", ...ctl] },
  "2.4.13": { title: "Focus Appearance", level: "AAA", appliesTo: ["style", ...ctl] },
  "2.5.1": { title: "Pointer Gestures", level: "A", appliesTo: ctl },
  "2.5.2": { title: "Pointer Cancellation", level: "A", appliesTo: ctl },
  "2.5.3": { title: "Label in Name", level: "A", appliesTo: ["link", "button", "form-control"] },
  "2.5.4": { title: "Motion Actuation", level: "A", appliesTo: "any" },
  "2.5.5": { title: "Target Size (Enhanced)", level: "AAA", appliesTo: ["style", ...ctl] },
  "2.5.6": { title: "Concurrent Input Mechanisms", level: "AAA", appliesTo: "any" },
  "2.5.7": { title: "Dragging Movements", level: "AA", appliesTo: ctl },
  "2.5.8": { title: "Target Size (Minimum)", level: "AA", appliesTo: ["style", ...ctl] },
  "3.1.1": { title: "Language of Page", level: "A", appliesTo: ["document"] },
  "3.1.2": { title: "Language of Parts", level: "AA", appliesTo: "any" },
  "3.1.3": { title: "Unusual Words", level: "AAA", appliesTo: "any" },
  "3.1.4": { title: "Abbreviations", level: "AAA", appliesTo: "any" },
  "3.1.5": { title: "Reading Level", level: "AAA", appliesTo: "any" },
  "3.1.6": { title: "Pronunciation", level: "AAA", appliesTo: "any" },
  "3.2.1": { title: "On Focus", level: "A", appliesTo: ctl },
  "3.2.2": { title: "On Input", level: "A", appliesTo: ["form-control", "interactive"] },
  "3.2.3": { title: "Consistent Navigation", level: "AA", appliesTo: ["landmark", "link", "document"] },
  "3.2.4": { title: "Consistent Identification", level: "AA", appliesTo: "any" },
  "3.2.5": { title: "Change on Request", level: "AAA", appliesTo: "any" },
  "3.2.6": { title: "Consistent Help", level: "A", appliesTo: "any" },
  "3.3.1": { title: "Error Identification", level: "A", appliesTo: ["form-control", "text"] },
  "3.3.2": { title: "Labels or Instructions", level: "A", appliesTo: ["form-control"] },
  "3.3.3": { title: "Error Suggestion", level: "AA", appliesTo: ["form-control", "text"] },
  "3.3.4": { title: "Error Prevention (Legal, Financial, Data)", level: "AA", appliesTo: "any" },
  "3.3.5": { title: "Help", level: "AAA", appliesTo: "any" },
  "3.3.6": { title: "Error Prevention (All)", level: "AAA", appliesTo: "any" },
  "3.3.7": { title: "Redundant Entry", level: "A", appliesTo: ["form-control"] },
  "3.3.8": { title: "Accessible Authentication (Minimum)", level: "AA", appliesTo: ["form-control", "interactive"] },
  "3.3.9": { title: "Accessible Authentication (Enhanced)", level: "AAA", appliesTo: ["form-control", "interactive"] },
  "4.1.2": { title: "Name, Role, Value", level: "A", appliesTo: ["link", "button", "form-control", "frame", "interactive", "img"] },
  "4.1.3": { title: "Status Messages", level: "AA", appliesTo: "any" },
} as const satisfies Record<string, ScInfo>;

export type WcagScId = keyof typeof WCAG_22;
const SC_IDS = Object.keys(WCAG_22) as [WcagScId, ...WcagScId[]];

/** Closed enum of real WCAG 2.2 success criteria. */
export const WcagSc = z.enum(SC_IDS);
export type WcagSc = z.infer<typeof WcagSc>;

export function scInfo(sc: WcagSc): ScInfo {
  return WCAG_22[sc];
}

export function scApplies(sc: WcagSc, kinds: readonly ElementKind[]): boolean {
  const a = WCAG_22[sc].appliesTo;
  if (a === "any") return true;
  return kinds.some((k) => (a as readonly ElementKind[]).includes(k));
}

export function understandingUrl(sc: WcagSc): string {
  const slug = WCAG_22[sc].title
    .toLowerCase()
    .replace(/[(),]/g, "")
    .replace(/\s+/g, "-");
  return `https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html`;
}
