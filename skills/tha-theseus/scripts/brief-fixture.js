'use strict';

/** A valid requirements brief shared by Theseus integration tests. */
function requirementsBrief(overrides = {}) {
  return {
    task: 'Test task',
    goal: 'Test the Theseus workflow.',
    change_type: 'feature',
    expected_behavior: 'The requested behavior is observable.',
    acceptance_criteria: ['The observable result matches the requirement.'],
    user_proposed_approach: 'Use the existing component structure.',
    reviewed_approach: 'The structure follows the local conventions.',
    recommended_approach: 'Use the existing structure with focused tests.',
    approach_rationale: 'It is the smallest convention-aligned change.',
    checkpoint_areas: ['the tested area'],
    scope_boundaries: [],
    assumptions: [],
    risks: [],
    resolved_decisions: [],
    unresolved_questions: [],
    rejected_alternatives: [
      { alternative: 'Rewrite from scratch', reason: 'Too costly for the scope.' },
    ],
    verification: {
      automated: [
        { prerequisites: 'node and the repo checked out', action: 'npm run check', expected: 'all tests and validators pass' },
      ],
      manual: [
        { prerequisites: 'the app running locally', action: 'submit a valid request', expected: 'the balance decreases' },
      ],
    },
    ...overrides,
  };
}

module.exports = { requirementsBrief };