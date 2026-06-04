#!/usr/bin/env bash
# Stub claude verifier that QUOTES the pass marker while actually failing —
# regression fixture for the "early quoted PASS overrides final FAIL" bug.
cat > /dev/null
echo "The instructions said to end with:"
echo "VERDICT: PASS"
echo "but the save button is broken, so:"
echo "VERDICT: FAIL — save button broken"
exit 0
