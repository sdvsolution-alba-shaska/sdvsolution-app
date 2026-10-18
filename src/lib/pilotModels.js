// Pilot Behavior Model templates. Everything here is a PROPOSAL (status "proposed"): types, thresholds and guards
// are engineering starting points to be confirmed by the function owner, the supplier datasheet and the review board.
// Seeding a function uses its template if one exists; the generator never treats a template as approved.

const sig = (name, dir, baseType, min, max, unit, init, extra = {}) => ({ name, dir, baseType, min, max, unit, resolution: extra.resolution || "", init, invalid: extra.invalid ?? "", note: extra.note || "" });
const cal = (name, baseType, value, unit, source) => ({ name, baseType, value, unit, source });
const SRC = "Proposed starting value — confirm with heater/mirror supplier datasheet";
const SRC2 = "Proposed starting value — confirm with mirror fold-motor supplier datasheet";
const SRC3 = "Proposed starting value — confirm with mirror-glass adjust-motor supplier datasheet";

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
      sig("door_can_timeout", "in", "boolean", 0, 1, "", 0, { invalid: 1, note: "Center_Door_CAN01 feedback from the DCM missing beyond its timeout (E2E / alive supervision). A failed read counts as TIMED OUT (safe)." }),
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
        { from: "HEATING", to: "FAULT", label: "open-load / short / timeout", guard: "load_status != 0 || door_can_timeout" },
        { from: "HEATING", to: "DEGR", label: "over-current / over-temp", guard: "heater_current_mA > CAL_OVERCURRENT_MA || mirror_temp_dC > CAL_OVERTEMP_DC" },
        { from: "HEATING", to: "OFF", label: "release / timeout", guard: "!ignition_on || (!heater_request && ambient_temp_dC >= CAL_AUTO_ON_TEMP_DC) || state_time_ms >= CAL_HEAT_MAX_MS" },
        { from: "DEGR", to: "FAULT", label: "bus timeout", guard: "door_can_timeout" },
        { from: "DEGR", to: "OFF", label: "de-rate / recovered", guard: "mirror_temp_dC <= CAL_OVERTEMP_DC - CAL_TEMP_HYST_DC && heater_current_mA <= CAL_OVERCURRENT_MA" },
        { from: "FAULT", to: "OFF", label: "cleared", guard: "load_status == 0 && !door_can_timeout && state_time_ms >= CAL_FAULT_RETRY_MS" },
      ],
    },
    status: "proposed", rev: 1, testIds: {}, seededFrom: "L2-BODY-00194-MODE", template: true,
  },
  "L2-BODY-00193-MODE": {
    id: "BM-L2-BODY-00193", function: "L2-BODY-00193-FUN", title: "FOLD DOWN EXTERIOR MIRRORS",
    implements: ["L2-BODY-00193-FUN", "L2-BODY-00193-IF", "L2-BODY-00193-PERF", "L2-BODY-00193-MODE", "L2-BODY-00193-DIAG", "L2-BODY-00193-SEC"],
    target: { ecu: "ECU-CZM", swc: "MirrorFold" },
    notes: "Hosting decision (confirmed by the product owner): this function is modelled and generated for the CZM; the door modules (DCM) execute the motor command and report position, current and status.",
    signals: [
      sig("fold_request", "in", "boolean", 0, 1, "", 0, { note: "HOLD (fold) switch or auto-fold on central locking / garage" }),
      sig("unfold_request", "in", "boolean", 0, 1, "", 0, { note: "UNFOLD switch" }),
      sig("vehicle_speed_kph", "in", "uint8", 0, 250, "km/h", 0, { invalid: 0, note: "Used for the no-fold-while-driving interlock and drive-away auto-unfold" }),
      sig("fold_position_pct", "in", "uint8", 0, 100, "%", 0, { note: "0 = fully unfolded (drive position), 100 = fully folded (latch / end stop)" }),
      sig("position_valid", "in", "boolean", 0, 1, "", 1, { invalid: 0, note: "Position/latch feedback is plausible. A failed read counts as INVALID (safe)." }),
      sig("motor_current_mA", "in", "uint16", 0, 20000, "mA", 0, { invalid: 0 }),
      sig("door_can_timeout", "in", "boolean", 0, 1, "", 0, { invalid: 1, note: "Center_Door_CAN01 feedback from the DCM missing beyond its timeout (E2E / alive supervision). A failed read counts as TIMED OUT (safe)." }),
      sig("motor_cmd", "out", "uint8", 0, 2, "enum", 0, { note: "0 stop · 1 fold-in (SP_FoldIn) · 2 fold-out (SP_FoldOut)" }),
      sig("fold_status", "out", "uint8", 0, 4, "enum", 0, { note: "0 unfolded · 1 folding · 2 folded · 3 unfolding · 4 fault (SSA_FT_ASP_Fold_Status)" }),
      sig("fold_fault", "out", "boolean", 0, 1, "", 0, { note: "SSA_FT_ASP_Fold_Fault" }),
    ],
    calibrations: [
      cal("CAL_FOLDED_POS_PCT", "uint8", 95, "%", SRC2 + " (folded end reached)"),
      cal("CAL_UNFOLDED_POS_PCT", "uint8", 5, "%", SRC2 + " (drive position reached)"),
      cal("CAL_DRIVE_AWAY_KPH", "uint16", 10, "km/h", SRC2 + " (no folding above; auto-unfold above)"),
      cal("CAL_AUTO_UNFOLD_EN", "boolean", 1, "", "Configuration — auto-unfold on drive-away 'where configured' (L2-BODY-00193-MODE)"),
      cal("CAL_STALL_CURRENT_MA", "uint16", 3000, "mA", SRC2),
      cal("CAL_STALL_DEBOUNCE_MS", "uint32", 200, "ms", SRC2 + " (debounce before a stall is confirmed)"),
      cal("CAL_FOLD_TIMEOUT_MS", "uint32", 8000, "ms", SRC2 + " (maximum fold / unfold travel time)"),
      cal("CAL_FAULT_RETRY_MS", "uint32", 3000, "ms", SRC2),
    ],
    runnable: { name: "Run", periodMs: 10 },
    stateMachine: {
      init: "UNF",
      states: [
        { id: "UNF", label: "Unfolded", outputs: { motor_cmd: "0", fold_status: "0", fold_fault: "false" } },
        { id: "FOLDING", label: "Folding", outputs: { motor_cmd: "1", fold_status: "1", fold_fault: "false" } },
        { id: "FOLDED", label: "Folded", outputs: { motor_cmd: "0", fold_status: "2", fold_fault: "false" } },
        { id: "UNFOLDING", label: "Unfolding", outputs: { motor_cmd: "2", fold_status: "3", fold_fault: "false" } },
        { id: "FAULT", label: "Fault → Safe", outputs: { motor_cmd: "0", fold_status: "4", fold_fault: "true" } },
      ],
      // Order = priority. Reaching the end stop must beat a stall (the current spikes AT the stop), so FOLDED is listed before FAULT.
      transitions: [
        { from: "UNF", to: "FOLDING", label: "fold req / auto-fold", guard: "fold_request && !unfold_request && vehicle_speed_kph <= CAL_DRIVE_AWAY_KPH" },
        { from: "FOLDING", to: "FOLDED", label: "latch reached", guard: "!door_can_timeout && position_valid && fold_position_pct >= CAL_FOLDED_POS_PCT" },
        { from: "FOLDED", to: "UNFOLDING", label: "unfold / drive-away", guard: "unfold_request || (CAL_AUTO_UNFOLD_EN && vehicle_speed_kph > CAL_DRIVE_AWAY_KPH)" },
        { from: "UNFOLDING", to: "UNF", label: "drive position", guard: "!door_can_timeout && position_valid && fold_position_pct <= CAL_UNFOLDED_POS_PCT" },
        { from: "UNFOLDING", to: "FAULT", label: "stall / timeout / bus loss", guard: "door_can_timeout || !position_valid || state_time_ms >= CAL_FOLD_TIMEOUT_MS || (motor_current_mA > CAL_STALL_CURRENT_MA && state_time_ms >= CAL_STALL_DEBOUNCE_MS)" },
        { from: "FOLDING", to: "FAULT", label: "stall / timeout / bus loss", guard: "door_can_timeout || !position_valid || state_time_ms >= CAL_FOLD_TIMEOUT_MS || (motor_current_mA > CAL_STALL_CURRENT_MA && state_time_ms >= CAL_STALL_DEBOUNCE_MS)" },
        { from: "FAULT", to: "UNF", label: "cleared", guard: "!door_can_timeout && position_valid && state_time_ms >= CAL_FAULT_RETRY_MS" },
      ],
    },
    status: "proposed", rev: 1, testIds: {}, seededFrom: "L2-BODY-00193-MODE", template: true,
  },
  "L2-BODY-00187-MODE": {
    id: "BM-L2-BODY-00187", function: "L2-BODY-00187-FUN", title: "ADJUSTING EXTERIOR MIRRORS",
    implements: ["L2-BODY-00187-FUN", "L2-BODY-00187-IF", "L2-BODY-00187-PERF", "L2-BODY-00187-MODE", "L2-BODY-00187-DIAG", "L2-BODY-00187-SEC"],
    target: { ecu: "ECU-CZM", swc: "MirrorAdjust" },
    notes: "Same hosting as Fold Down (CZM chip B): the CZM decides and commands; the addressed door module (DCM) drives the mirror-glass motor and reports position, current and status on Center_DOOR_CAN01. Hold-to-run: the motor moves only while the switch is held (OV-MIR-01); a stall or over-current stops it and requests a DTC (OV-MIR-02).",
    signals: [
      sig("power_mode", "in", "uint8", 0, 3, "enum", 0, { invalid: 0, note: "0 Sleep · 1 Standby · 2 Active · 3 Retained accessory (post-run). A failed read counts as Sleep (adjustment rejected)." }),
      sig("adjust_axis_req", "in", "uint8", 0, 4, "enum", 0, { invalid: 0, note: "Mirror-adjust switch, held: 0 none · 1 up · 2 down · 3 left · 4 right" }),
      sig("mirror_select", "in", "uint8", 0, 2, "enum", 0, { invalid: 0, note: "L/R selector: 0 none · 1 driver (left) · 2 passenger (right)" }),
      sig("request_authentic", "in", "boolean", 0, 1, "", 0, { invalid: 0, note: "Request passed authentication / freshness (SecOC on Center_DOOR_CAN01). A failed read counts as NOT authentic." }),
      sig("mirror_fitted", "in", "boolean", 0, 1, "", 0, { invalid: 0, note: "The selected mirror has an adjust motor (variant coding); otherwise 'no mirror to adjust'" }),
      sig("position_valid", "in", "boolean", 0, 1, "", 1, { invalid: 0, note: "Mirror-glass position feedback is plausible. A failed read counts as INVALID (safe)." }),
      sig("axis_at_limit", "in", "boolean", 0, 1, "", 0, { invalid: 1, note: "The selected axis reached its travel end in the requested direction. A failed read counts as AT LIMIT (motor stops)." }),
      sig("motor_current_mA", "in", "uint16", 0, 20000, "mA", 0, { invalid: 0 }),
      sig("motor_overtemp", "in", "boolean", 0, 1, "", 0, { invalid: 1, note: "Motor / driver thermal protection active (reported by the DCM). A failed read counts as OVER-TEMP (safe)." }),
      sig("door_can_timeout", "in", "boolean", 0, 1, "", 0, { invalid: 1, note: "Center_DOOR_CAN01 feedback from the DCM missing beyond its timeout (E2E / alive supervision). A failed read counts as TIMED OUT (safe)." }),
      sig("motor_cmd", "out", "uint8", 0, 4, "enum", 0, { note: "0 stop · 1 up · 2 down · 3 left · 4 right (to the addressed DCM)" }),
      sig("mirror_target", "out", "uint8", 0, 2, "enum", 0, { note: "0 none · 1 driver (left) · 2 passenger (right)" }),
      sig("adjust_status", "out", "uint8", 0, 4, "enum", 0, { note: "0 idle · 1 checking · 2 adjusting · 3 blocked · 4 fault" }),
      sig("adjust_fault", "out", "boolean", 0, 1, "", 0, { note: "Request to log a DTC (stall / over-current / over-temp / feedback loss / bus timeout)" }),
    ],
    calibrations: [
      cal("CAL_MIN_POWER_MODE", "uint8", 2, "enum", "Configuration — adjustment allowed in Active (2) and Retained accessory (3) (L2-BODY-00187-MODE)"),
      cal("CAL_AUTH_TIMEOUT_MS", "uint32", 200, "ms", "Proposed — time allowed for the request to authenticate before it is denied"),
      cal("CAL_STALL_CURRENT_MA", "uint16", 1500, "mA", SRC3),
      cal("CAL_STALL_DEBOUNCE_MS", "uint32", 150, "ms", SRC3 + " (debounce before a stall is confirmed)"),
      cal("CAL_MAX_ADJUST_MS", "uint32", 10000, "ms", SRC3 + " (longest continuous drive before the motor is protected)"),
      cal("CAL_RECOVER_MS", "uint32", 2000, "ms", SRC3 + " (cool-down after a block)"),
      cal("CAL_FAULT_RETRY_MS", "uint32", 3000, "ms", SRC3),
    ],
    runnable: { name: "Run", periodMs: 10 },
    stateMachine: {
      init: "IDLE",
      states: [
        { id: "IDLE", label: "Idle", outputs: { motor_cmd: "0", mirror_target: "0", adjust_status: "0", adjust_fault: "false" } },
        { id: "AUTH", label: "Authenticating", outputs: { motor_cmd: "0", mirror_target: "0", adjust_status: "1", adjust_fault: "false" } },
        { id: "VALID", label: "Validating", outputs: { motor_cmd: "0", mirror_target: "0", adjust_status: "1", adjust_fault: "false" } },
        { id: "ADJ", label: "Adjusting", outputs: { motor_cmd: "adjust_axis_req", mirror_target: "mirror_select", adjust_status: "2", adjust_fault: "false" } },
        { id: "DEGR", label: "Degraded / Blocked", outputs: { motor_cmd: "0", mirror_target: "0", adjust_status: "3", adjust_fault: "true" } },
        { id: "FAULT", label: "Fault → Safe", outputs: { motor_cmd: "0", mirror_target: "0", adjust_status: "4", adjust_fault: "true" } },
      ],
      // Order = priority within a state. In ADJ: feedback loss / timeout first, then a normal stop (release or travel end — the
      // current rises AT the end stop, so reaching the limit must beat the stall check), then stall / over-current / over-temp.
      transitions: [
        { from: "IDLE", to: "AUTH", label: "adjust request", guard: "adjust_axis_req != 0 && mirror_select != 0 && power_mode >= CAL_MIN_POWER_MODE" },
        { from: "AUTH", to: "VALID", label: "granted", guard: "request_authentic && adjust_axis_req != 0" },
        { from: "AUTH", to: "IDLE", label: "denied", guard: "(!request_authentic && state_time_ms >= CAL_AUTH_TIMEOUT_MS) || adjust_axis_req == 0 || power_mode < CAL_MIN_POWER_MODE" },
        { from: "VALID", to: "ADJ", label: "valid", guard: "mirror_fitted && position_valid && !door_can_timeout && !axis_at_limit && adjust_axis_req != 0 && power_mode >= CAL_MIN_POWER_MODE" },
        { from: "VALID", to: "IDLE", label: "invalid / no mirror", guard: "true" }, // otherwise: exactly the negation of "valid", so Validating always exits in one cycle (no unreachable branch)
        { from: "ADJ", to: "FAULT", label: "feedback loss / timeout", guard: "door_can_timeout || !position_valid" },
        { from: "ADJ", to: "IDLE", label: "complete / release", guard: "adjust_axis_req == 0 || axis_at_limit || power_mode < CAL_MIN_POWER_MODE" },
        { from: "ADJ", to: "DEGR", label: "stall / over-current", guard: "(motor_current_mA > CAL_STALL_CURRENT_MA && state_time_ms >= CAL_STALL_DEBOUNCE_MS) || motor_overtemp || state_time_ms >= CAL_MAX_ADJUST_MS" },
        { from: "DEGR", to: "IDLE", label: "recovered", guard: "adjust_axis_req == 0 && !motor_overtemp && state_time_ms >= CAL_RECOVER_MS" },
        { from: "FAULT", to: "IDLE", label: "cleared", guard: "!door_can_timeout && position_valid && state_time_ms >= CAL_FAULT_RETRY_MS" },
      ],
    },
    status: "proposed", rev: 1, testIds: {}, seededFrom: "L2-BODY-00187-MODE", template: true,
  }
};
