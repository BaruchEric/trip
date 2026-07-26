import type { Segment } from "@/segments";

export type Mode = "walking" | "transit";
export type Pace = "easy" | "normal" | "packed";

/** Decision 10: pace caps SEGMENTS per day, never walking distance. */
export const PACE_CEILING: Record<Pace, number> = { easy: 3, normal: 5, packed: 7 };

/** 12:30 and 19:30. Fixed constants in M2 — they earn a flag when Eric wants
 *  different ones, not before. */
export const MEAL_WINDOWS = [12 * 60 + 30, 19 * 60 + 30];

export const MODES: Mode[] = ["walking", "transit"];
export const PACES: Pace[] = ["easy", "normal", "packed"];

export interface Point {
  latitude: number;
  longitude: number;
}

/** A segment that can actually be placed: coordinates are known. */
export type PlannableSegment = Segment & Point;

export function isPlannable(s: Segment): s is PlannableSegment {
  // Explicit null checks, not truthiness: 0 is a real coordinate.
  return s.latitude !== null && s.longitude !== null;
}

export interface Pin {
  segmentId: number;
  day: number;
  /** null = day-locked but free to move within the day. `trip move` produces
   *  these; `trip pin --at` produces a fixed time. */
  startMin: number | null;
}

export interface Placement {
  segmentId: number;
  day: number;
  ordinal: number;
  startMin: number;
  endMin: number;
  pinned: boolean;
}

export interface Unplaced {
  segmentId: number;
  reason: string;
}

export interface CompileResult {
  placements: Placement[];
  unplaced: Unplaced[];
}
