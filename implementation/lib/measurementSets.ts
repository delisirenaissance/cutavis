import type { Measurements } from "./types";

export const MEASUREMENT_SETS: Record<string, Measurements> = {
  "38 (EU)": {
    BrU: 88,
    uBrU: 71,
    TaU: 72,
    HueU: 97,
    sTaH: 106,
    HueT: 20.6,
    HaU: 36,
    RueL: 41.6,
    BrT1: 34.8,
    VL1: 52,
    ArL: 59.9,
    OaU: 28,
    HgU: 15.8,
    SiH: 26.1,
    SrH: 79.9,
    FeU: 24.5,
  },
  "40 (EU)": {
    BrU: 92,
    uBrU: 75,
    TaU: 76,
    HueU: 100,
    sTaH: 106,
    HueT: 20.6,
    HaU: 36.6,
    RueL: 41.8,
    BrT1: 35.7,
    VL1: 52.7,
    ArL: 60.2,
    OaU: 29.2,
    HgU: 16.2,
    SiH: 26.5,
    SrH: 79.5,
    FeU: 25,
  },
};

export const MEASUREMENT_SET_NAMES = Object.keys(MEASUREMENT_SETS);

// Canonical variable order taken from measurement_variables.csv
export const MEASUREMENT_VARIABLE_NAMES = Object.keys(MEASUREMENT_SETS["38 (EU)"]);

/*export const MEASUREMENT_VARIABLE_NAMES = [
    "chest",
    "underbust",
    "waist",
    "hip (around butt)",
    "side length floor to waist",
    "waist to hip, measured along side",
    "neck",
    "back length",
    "neck (back) to chest",
    "neck (back) to waist",
    "arm lenght",
    "upper arm circumference",
    "wrist circumference",
    "sitting height",
    "floor to crotch",
    "ankle circumference"
]*/
