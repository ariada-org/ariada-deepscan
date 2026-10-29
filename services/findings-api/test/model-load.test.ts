import { describe, it, expect } from "vitest";
import { cpuCores, combine } from "../src/model-load.js";

describe("cpuCores", () => {
  it("reads the units metrics-server uses", () => {
    expect(cpuCores("1850000000n")).toBeCloseTo(1.85);
    expect(cpuCores("250m")).toBeCloseTo(0.25);
    expect(cpuCores("3500u")).toBeCloseTo(0.0035);
    expect(cpuCores("2")).toBe(2);
    expect(cpuCores("lots")).toBeNaN();
  });
});

describe("combine", () => {
  const loaded = (vram: number) => ({ models: [{ name: "qwen2.5-coder:7b", size: 7_000, size_vram: vram }] });

  it("mock has nothing to measure", () => {
    expect(combine("mock", null, null, null)).toEqual({ runsOn: "mock", name: null, device: null, pct: null, cores: null });
  });

  it("host: the GPU share when the model sits in GPU memory, the CPU share when it does not", () => {
    const host = { gpuPct: 76, cpuPct: 31 };
    expect(combine("host", loaded(7_000), host, null)).toMatchObject({ device: "gpu", pct: 76, cores: null, name: "qwen2.5-coder:7b" });
    expect(combine("host", loaded(0), host, null)).toMatchObject({ device: "cpu", pct: 31 });
  });

  it("host: an unreachable reporter or unloaded model leaves the numbers unknown, not zero", () => {
    expect(combine("host", loaded(7_000), null, null)).toMatchObject({ device: "gpu", pct: null });
    expect(combine("host", { models: [] }, { gpuPct: 5, cpuPct: 5 }, null)).toMatchObject({ name: null, device: null, pct: null });
  });

  it("cluster: CPU cores of the pod, rounded to a tenth", () => {
    expect(combine("cluster", loaded(0), null, 1.8734)).toMatchObject({ device: "cpu", cores: 1.9, pct: null });
    expect(combine("cluster", null, null, null)).toMatchObject({ device: "cpu", cores: null });
  });
});
