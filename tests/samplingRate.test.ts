import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAMPLE_INTERVAL_MICRO_S,
  MAX_SAMPLE_INTERVAL_MICRO_S,
  MIN_SAMPLE_INTERVAL_MICRO_S,
  SAMPLE_INTERVAL_PRESETS_MICRO_S,
  checkSampleIntervalMicroS,
} from "../src/shared/samplingRate";

describe("checkSampleIntervalMicroS", () => {
  it("keeps every offered preset unchanged", () => {
    for (const preset of SAMPLE_INTERVAL_PRESETS_MICRO_S) {
      expect(checkSampleIntervalMicroS(preset)).toBe(preset);
    }
  });

  it("clamps values outside the supported range", () => {
    expect(checkSampleIntervalMicroS(0)).toBe(MIN_SAMPLE_INTERVAL_MICRO_S);
    expect(checkSampleIntervalMicroS(-5)).toBe(MIN_SAMPLE_INTERVAL_MICRO_S);
    expect(checkSampleIntervalMicroS(10 ** 9)).toBe(
      MAX_SAMPLE_INTERVAL_MICRO_S,
    );
  });

  it("rounds fractional microseconds", () => {
    expect(checkSampleIntervalMicroS(123.4)).toBe(123);
    expect(checkSampleIntervalMicroS(123.6)).toBe(124);
  });

  it("falls back to the default for values that are not numbers", () => {
    expect(checkSampleIntervalMicroS(undefined)).toBe(
      DEFAULT_SAMPLE_INTERVAL_MICRO_S,
    );
    expect(checkSampleIntervalMicroS("fast")).toBe(
      DEFAULT_SAMPLE_INTERVAL_MICRO_S,
    );
    expect(checkSampleIntervalMicroS(NaN)).toBe(
      DEFAULT_SAMPLE_INTERVAL_MICRO_S,
    );
  });

  it("accepts numeric strings, which is what a select element yields", () => {
    expect(checkSampleIntervalMicroS("250")).toBe(250);
  });
});
