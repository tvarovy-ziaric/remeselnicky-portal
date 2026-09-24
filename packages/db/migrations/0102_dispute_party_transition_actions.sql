-- Enum additions must commit before the workflow migration can use them.
ALTER TYPE dispute_case_transition_action ADD VALUE 'WITHDRAW';
ALTER TYPE dispute_case_transition_action ADD VALUE 'CONFIRM_SETTLEMENT';
ALTER TYPE dispute_admin_command_action ADD VALUE 'SET_INVESTIGATION_HOLD';
ALTER TYPE dispute_admin_command_action ADD VALUE 'CLEAR_INVESTIGATION_HOLD';
