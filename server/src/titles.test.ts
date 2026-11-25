import { describe, expect, it } from "vitest";
// The tidier is shared with the web app (identical copies; see mergehints.test.ts).
import { tidyTitle } from "./titles.js";

describe("tidyTitle", () => {
  it.each([
    [
      "[Σ-Arts (Mikemono Yuu)] Natsu to Inaka to Yuuwaku shite kuru Dekkai Oshiego | Summertime in the Countryside With The Huge Student Seducing Me [English] {RedLantern} [Decensored] [Digital]",
      "Summertime in the Countryside With The Huge Student Seducing Me",
    ],
    ["[Dagashiya (Wagashi)] Onozuka-senpai wa Warui Hito | Onozuka-senpai Is A Very Bad Girl [English] [head empty] [Decensored] [Digital]", "Onozuka-senpai Is A Very Bad Girl"],
    ["[Nazunasoft (Katsura Harufumi)] Now She's Mine [Uncensored] [Digital] / Soshite, Kanojo wa Boku no Mono ni Natta....", "Now She's Mine"],
    ["[Aiue Oka] Bullied ~Revenge Hypnosis~ (UNCENSORED) [english]", "Bullied ~Revenge Hypnosis~"],
    ["[Sakura no Tomoru Hi e] Gal Mama Anna-san [English] [korafu]", "Gal Mama Anna-san"],
    ["Metamorphosis (ShindoL) Uncensored", "Metamorphosis"],
    ["[Hirune] Training Utahara-san 1-4 | Utahara-san Choukyou Chuu Ch. 1-4 [English] [Decensored]", "Training Utahara-san 1-4"],
    ["(C99) [Circle] Some Title [English]", "Some Title"],
  ])("%s", (raw, want) => {
    expect(tidyTitle(raw)).toBe(want);
  });

  it("leaves ordinary titles alone", () => {
    for (const t of ["Solo Leveling", "Return of the Mount Hua Sect", "Re:Zero (Light Novel)", "Kaguya-sama wa Kokurasetai", "Spy x Family"]) {
      expect(tidyTitle(t)).toBe(t);
    }
  });

  it("falls back to the full title when nothing would be left", () => {
    expect(tidyTitle("[English] [Digital]")).toBe("[English] [Digital]");
  });
});
