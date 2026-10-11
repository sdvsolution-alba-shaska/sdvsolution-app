// Pilot Behavior Model templates. Everything here is a PROPOSAL (status "proposed"): types, thresholds and guards
// are engineering starting points to be confirmed by the function owner, the supplier datasheet and the review board.
// Seeding a function uses its template if one exists; the generator never treats a template as approved.

const sig = (name, dir, baseType, min, max, unit, init, extra = {}) => ({ name, dir, baseType, min, max, unit, resolution: extra.resolution || "", init, invalid: extra.invalid ?? "", note: extra.note || "" });
const cal = (name, baseType, value, unit, source) => ({ name, baseType, value, unit, source });
const SRC = "Proposed starting value — confirm with heater/mirror supplier datasheet";

export const PILOT_MODELS = {
  "L2-BODY-00194-MODE": {
    id: "BM-L2-BODY-00194", function: "L2-BODY-00194-FUN", title: "HEATING EXTERIOR MIRRORS",
    implements: ["L2-BODY-00194-FUN", "L2-BODY-00194-IF", "L2-BODY-00194-PERF", "L2-BODY-00194-DIAG", "L2-BODY-00194-SEC"],
    target: { ecu: "ECU-CZM", swc: "MirrorHeating" },
    signals: [
      sig("ignition_on", "in", "boolean", 0, 1, "", 0),
      sig("heater_request", "in", "boolean", 0, 1, "", 0, { note: "Driver request (HMI / button)" }),
      sig("ambient_temp_dC", "in", "sint16", -400, 850, "0.1 °C", 200, { resolution: "0.1", invalid: 200, note: "Outside temperature; substitute 20.0 °C if invalid" }),
      sig("mirror_temp_dC", "in", "sint16", -400, 1500, "0.1 °C", 200, { resolution: "0.1", invalid: 200 }),
      sig("heater_current_mA", "in", "uint16", 0, 20000, "mA", 0, { invalid: 0 }),
      sig("load_status", "in", "uint8", 0, 3, "enum", 0, { note: "0 OK · 1 open load · 2 short to ground · 3 short to battery", invalid: 0 }),
      sig("heater_pwm_pct", "out", "uint8", 0, 100, "%", 0, { note: "Heater drive duty cycle" }),
      sig("heater_fault", "out", "boolean", 0, 1, "", 0, { note: "Request to log a heater fault" }),
    ],
    calibrations: [
      cal("CAL_AUTO_ON_TEMP_DC", "sint16", 30, "0.1 °C", SRC),
      cal("CAL_OVERCURRENT_MA", "uint16", 5000, "mA", SRC),
      cal("CAL_OVERTEMP_DC", "sint16", 600, "0.1 °C", SRC),
      cal("CAL_TEMP_HYST_DC", "uint16", 100, "0.1 °C", SRC),
      cal("CAL_HEAT_MAX_MS", "uint32", 600000, "ms", SRC + " (10 min auto-off)"),
      cal("CAL_FAULT_RETRY_MS", "uint32", 5000, "ms", SRC),
      cal("CAL_PWM_FULL_PCT", "uint8", 100, "%", SRC),
      cal("CAL_PWM_DERATE_PCT", "uint8", 50, "%", SRC),
    ],
    runnable: { name: "Run", periodMs: 10 },
    stateMachine: {
      init: "OFF",
      states: [
        { id: "OFF", label: "Off (clear)", outputs: { heater_pwm_pct: "0", heater_fault: "false" } },
        { id: "HEATING", label: "Heating", outputs: { heater_pwm_pct: "CAL_PWM_FULL_PCT", heater_fault: "false" } },
        { id: "DEGR", label: "Degraded (over-temp)", outputs: { heater_pwm_pct: "CAL_PWM_DERATE_PCT", heater_fault: "false" } },
        { id: "FAULT", label: "Fault → Off (safe)", outputs: { heater_pwm_pct: "0", heater_fault: "true" } },
      ],
      // Order = priority: protective transitions are listed before the normal release.
      transitions: [
        { from: "OFF", to: "HEATING", label: "heater request / auto-on", guard: "ignition_on && (heater_request || ambient_temp_dC < CAL_AUTO_ON_TEMP_DC)" },
        { from: "HEATING", to: "FAULT", label: "open-load / short", guard: "load_status != 0" },
        { from: "HEATING", to: "DEGR", label: "over-current / over-temp", guard: "heater_current_mA > CAL_OVERCURRENT_MA || mirror_temp_dC > CAL_OVERTEMP_DC" },
        { from: "HEATING", to: "OFF", label: "release / timeout", guard: "!ignition_on || (!heater_request && ambient_temp_dC >= CAL_AUTO_ON_TEMP_DC) || state_time_ms >= CAL_HEAT_MAX_MS" },
        { from: "DEGR", to: "OFF", label: "de-rate / recovered", guard: "mirror_temp_dC <= CAL_OVERTEMP_DC - CAL_TEMP_HYST_DC && heater_current_mA <= CAL_OVERCURRENT_MA" },
        { from: "FAULT", to: "OFF", label: "cleared", guard: "load_status == 0 && state_time_ms >= CAL_FAULT_RETRY_MS" },
      ],
    },
    status: "proposed", rev: 1, testIds: {}, seededFrom: "L2-BODY-00194-MODE", template: true,
  },
};
