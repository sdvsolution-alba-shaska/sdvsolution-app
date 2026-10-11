# Audit: DCM requirements and K-matrix vs. the CZM hosting decision

Scope: the two mirror functions with Behavior Models, **Fold Down Exterior Mirrors** (`L2-BODY-00193`) and **Heating Exterior Mirrors** (`L2-BODY-00194`).
Decision (product owner): the control logic (state machine) is hosted on the **CZM**. The door modules (DCM) execute the actuator command, sense, and report.
Source: `src/App.jsx` (requirement texts `REQ_STATEMENTS`, L3/L4 lists, K-matrix `KM_*` data), `src/lib/pilotModels.js`.

## Already changed
| What | Change |
|---|---|
| Functional diagrams (Fold, Heating) and Heating boundary diagram | CZM hosts control; DCM drives/senses/reports |
| K-matrix sender/receiver table (`SEND`) | `Fold_Cmd_01`, `Heat_Cmd_01`: sender **CZM** (was CCU), receiver DCM_FL. `Fold_Status_01`, `Heat_Status_01`: sender DCM_FL, receiver **CZM** (was CCU). Affects the ARXML/K-matrix exports |
| Pilot model note | records the decision |

The K-matrix *directions* were already right: the command frames are Rx at the DCM and the notes already say "from Center Zone Module". Only the sender/receiver table was wrong.

## Update: bus gaps K1–K10 closed in the K-matrix
Added on Center_Door_CAN01 (guarded by `tests/kmatrix-mirrors.test.mjs`, which maps every model signal to a bus signal and checks direction, range and frame layout):
- **K1/K7 requests:** `Fold_Request_01` (`FT_SW_FoldHold`, `FT_SW_Unfold`) and `Heat_Request_01` (`FT_SW_HeaterReq`), DCM_FL → CZM.
- **K2/K3 fold feedback:** `Fold_Status_01` gains `FT_ASP_Fold_Position` (0–100 %), `FT_ASP_Fold_PosValid` and `FT_ASP_Fold_MotorCurrent` (mA).
- **K4:** "both SP_FoldIn and SP_FoldOut set" is defined as invalid (motor stops, `driver_fault`).
- **K5:** `Fold_Status` is documented as the DCM's *mechanical* state (stopped / folding / unfolding / end stop); the function state stays on the CZM.
- **K6:** fold command and status now cycle at 10 ms.
- **K8 heating feedback:** `Heat_Status_01` gains `FT_ASP_Heating_Current` and `FT_ASP_Mirror_Temp`; `Heating_Fault` is now the 4-value load status (OK / open load / short to ground / short to battery). Ambient temperature: new `Ambient_Env_01` (CCU → CZM).
- **K9:** `Heat_Cmd_01` gains `SP_Heating_Duty` (0–100 %). Heating command and status now cycle at 20 ms.
- **K10 passenger side:** `Fold_Status_02` and `Heat_Status_02` (DCM_FR → CZM, `SSA_BFT_*`); the command frames now list DCM_FR as a receiver.
- Value tables and scalings (`CM_FoldReq`, `CM_FoldStatus`, `CM_FoldFault`, `CM_MirHeatFault`, `CM_Pct`, `CM_mA`, `CM_Temp_0p1`, …) are defined; several of these names were referenced before but never defined.
- `vehicle_speed_kph` and `ignition_on` already reach the CZM on `IMirror_In_01` (Vehicle_Speed, Ignition_Mode).

Still open: section A (requirement wording), who owns the function-level DTCs, and the bus-timeout input (section C.1). `Heat_Cmd_01` at 20 ms and `Heat_Status_01` at 20 ms are my choice; confirm.

## Update: requirement wording rewritten (section A done)
For both 00193 and 00194: L2 `-FUN`, `-IF`, `-PERF`, `-DIAG`, `-SEC`, `-BND`, `-ARCH`; L3 `SW-01..06` and `AR-01..05` re-allocated to the CZM (with `ecu: ECU-CZM`) or, for `SW-06`, rewritten as DCM execution; new L3 `SW-07` (DCM actuator execution and feedback) and `AR-06` (DCM actuator component) with L4 children. L3 hardware items unchanged. Diagnostics split as proposed: the DCM sets electrical DTCs, the CZM sets function-level DTCs. Not rewritten: `-MODE` (no host named) and the test-case texts (section C.4).

## Update: test-case texts reworked (section C.4 done)
System- and software-level curated test cases for both functions now describe the CZM as the controller and the DCM as the executor. Added cases: both fold command bits set, spoofed fold request (appended at the end of their lists, because test-case IDs are index-based and inserting earlier would shift existing IDs and their recorded results), and new L3 cases for the DCM actuator items `SW-07` (lost command, both-set command, feedback rate, load-status classification).

## A. Requirement text that still says "DCM hosts the control" (needs your wording decision)
Each is the same pattern for 00193 and 00194.

| ID | Current statement | Proposed change |
|---|---|---|
| L2 `-FUN` | "DCM_FL shall authenticate the user, validate the input, check the fold/latch state, and send SP_FoldIn/SP_FoldOut …" and "passenger/rear DCMs coordinate" | The **CZM** authenticates/validates, checks state and issues SP_FoldIn/Out; DCM_FL/FR execute and report. Rear DCMs report "no mirror" |
| L2 `-IF` | "fold-switch input … into the driver DCM" | The request reaches the CZM (see K-matrix gap K1) |
| L2 `-PERF` | "each DCM FoldControl runnable shall execute on a 10 ms period" | The **CZM** FoldControl runnable (10 ms; matches the Behavior Model). DCM executes within its own latency budget |
| L2 `-MODE` | no host named (OK). States match the model except wording "Blocked / Degraded" (see C) | none |
| L2 `-DIAG` | "Each DCM shall monitor over-current, stall, …, and set DTCs … reported to the CZM" | Split: DCM measures/qualifies electrical faults and reports; the CZM owns function-level faults (stall, timeout, position invalid) and DTCs for them. Needs a decision on who owns the DTC |
| L2 `-SEC` | "The driver DCM shall authenticate the fold/unfold request" | The CZM authenticates the request; the DCM verifies SecOC on the CZM command |
| L2 `-BND` | "System under design: the four Door Control Modules" and CZM listed as an **external** actor | System under design = the function on the CZM; DCMs are external (actuator/sensor modules). Heating boundary *diagram* already changed; the text has not |
| L2 `-ARCH` | "DCM_FL hosts the mirror-fold control … CZM gates vehicle/ignition status" | Contradicts the new diagram. Must be rewritten |
| L3 `SW-01` | "DCM software shall implement the fold sequence … and the state machine" | Move to a **CZM** FoldControl SWC. Add a new DCM L3 "execute fold command, monitor completion" |
| L3 `SW-02` | DCM scheduler 10 ms | CZM 10 ms task, plus a DCM-side actuator task |
| L3 `SW-03` | DCM packs/unpacks SP_FoldIn/Out as the receiver | Both: CZM is sender of cmd, receiver of status |
| L3 `SW-04` | DCM diagnostics | Split by owner (see `-DIAG`) |
| L3 `SW-05` | DCM verifies SecOC on commands | Stays for the DCM receive side; add CZM generate side |
| L3 `SW-06` | passenger/rear DCM "follow the driver-side sequence" | Passenger DCM executes the CZM command (no peer-to-peer coordination) |
| L3 `AR-01..05` | DCM composition `FoldControl_FL`, `FoldControl SWC` on the DCM | `FoldControl` SWC on the CZM; DCM has an actuator SWC |
| L3 `HW-01..04` | DCM driver, transceiver, sensing | **No change** (drivers and sensors stay on the DCM) |

Every ID above exists twice (`00193` and `00194`; `HeatControl` instead of `FoldControl`).

## B. K-matrix gaps between the Behavior Models and the bus
The CZM can only run the model if every model input arrives on a bus signal, and every output maps to one.

**Fold (`MirrorFold`)**

| Model signal | On the bus today? | Gap |
|---|---|---|
| `fold_request`, `unfold_request` (switch / auto-fold) | **No.** There is no switch-request frame to the CZM | **K1**: the HOLD/UNFOLD switch is read at the driver door; add a request signal DCM_FL → CZM (or confirm it comes via the CCU / HMI) |
| `vehicle_speed_kph` | Not in this matrix | Presumed on the platform CAN to the CZM; confirm |
| `fold_position_pct`, `position_valid` | **No.** `Fold_Status_01` carries only Status (2 bit), Fault (2 bit), Unlatched (1 bit) | **K2**: add position (0–100 %) and a validity flag to `Fold_Status_01` |
| `motor_current_mA` | **No** | **K3**: add motor current (or have the DCM do stall detection and report it). Moving stall detection to the DCM would change the model |
| `motor_cmd` (0 stop / 1 fold / 2 unfold) | Yes: `SP_FoldIn`, `SP_FoldOut` (2 × 1 bit); both set must be defined as invalid | **K4**: define "both set" |
| `fold_status` (5 states) | `SSA_FT_ASP_Fold_Status` is **2 bits** | **K5**: the CZM owns the state now, so this status is the DCM's *motor/mechanical* state, not the function state. Define both |
| `fold_fault` | `SSA_FT_ASP_Fold_Fault` (2 bit) | OK, values to be defined |
| Timing | Cmd 20 ms, status 40 ms; model runs every 10 ms and uses a 200 ms stall debounce | **K6**: 40 ms status is coarse for the 200 ms stall debounce; confirm acceptable |

**Heating (`MirrorHeating`)**

| Model signal | On the bus today? | Gap |
|---|---|---|
| `heater_request` | `SP_Heating_Ant` is *from* the CZM | **K7**: the driver request source must reach the CZM (same as K1) |
| `ignition_on`, `ambient_temp_dC` | not in this matrix | presumed CZM-local or platform CAN; confirm |
| `mirror_temp_dC`, `heater_current_mA`, `load_status` (0–3) | **No.** `Heat_Status_01` has Status + Fault (2 bits each) | **K8**: add current and mirror temperature, and carry the 4-value load status (the 2-bit Fault can hold it only if the enum is fixed) |
| `heater_pwm_pct` (0–100 %) | **No.** `SP_Heating_Ant` is 1 bit | **K9**: either add a duty-cycle signal, or the DCM does the PWM and the model output becomes on/off |
| `heater_fault` | `SSA_FT_ASP_Heating_Fault` | OK |
| Passenger side (`SSA_BFT_*`) | named in the L2 texts, **not in any K-matrix** in the app (only the DCM_FL matrix exists) | **K10**: the DCM_FR matrix is missing |

## C. Other inconsistencies found
1. `L2-BODY-00194-MODE` text and the architecture state machine label HEATING→FAULT as "open-load / short / timeout" but the model has no timeout transition; the text also mentions a Center_Door_CAN01 timeout fault that neither model implements (no bus-timeout input signal; see K-matrix). The Fold model has the same gap: "Fault on … Center_Door_CAN01 timeout" has no model input.
2. `L2-BODY-00193-MODE` mentions "Blocked / Degraded" for fold; the model has a single FAULT state.
3. `L2-BODY-00193-MODE` mentions "retain the last fold state across Sleep" and power modes; the model has no power-mode or persisted state, so that text is not generated or tested.
4. Test cases (`Nominal fold-in`, etc.) were written against the DCM allocation; their preconditions say "bus trace on Center_Door_CAN01", which is still valid, but "Fold-command stops on latch/over-current ... computeFoldCommand" names a DCM function.

## Recommended order
1. Decide K1–K10 (bus signals). These change what the CZM can see, so the model inputs depend on them.
2. Rewrite the L2 `-FUN/-IF/-PERF/-BND/-ARCH` texts and the L3 `SW/AR` allocation (section A) once K1–K10 are decided, so the wording and the signals agree.
3. Then diagnostics ownership (`-DIAG`, `SW-04`) and security (`-SEC`, `SW-05`).
