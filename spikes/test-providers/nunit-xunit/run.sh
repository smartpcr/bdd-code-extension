#!/bin/bash
# usage: run.sh <project-dir> <label> [dotnet test args...]
# Runs dotnet test with a TRX logger into out/<label>, prints exit code, the event log, and TRX results.
P=$1; L=$2; shift 2
D=$(cd "$(dirname "$0")" && pwd)
OUT=$D/out/$L; rm -rf $OUT; mkdir -p $OUT
export SPIKE_LOG=$(cygpath -w $OUT/events.log)
dotnet test $D/$P --no-build --logger "trx;LogFileName=r.trx" --results-directory $(cygpath -w $OUT) "$@" > $OUT/console.txt 2>&1
echo "EXIT=$?"
echo "--- console (filtered)"; grep -vE '^\s*$|Test run for|VSTest version|Starting test execution|A total of|Results File' $OUT/console.txt | head -40
echo "--- events"; cat $OUT/events.log 2>/dev/null
echo "--- trx results"; grep -oE '<UnitTestResult [^>]*' $OUT/r.trx | grep -oE 'testName="[^"]*"|outcome="[^"]*"' | paste - - 
echo "--- trx counters"; grep -oE '<Counters [^>]*' $OUT/r.trx
grep -oE '<ResultSummary outcome="[^"]*"' $OUT/r.trx
