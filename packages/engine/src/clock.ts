import type { Clock } from "./types.js";

export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }
}
