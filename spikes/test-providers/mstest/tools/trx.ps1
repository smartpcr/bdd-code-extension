param([string]$Path)
[xml]$x = Get-Content -Raw $Path
$ns = @{t='http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
foreach ($r in (Select-Xml -Xml $x -XPath '//t:UnitTestResult' -Namespace $ns)) {
  $n = $r.Node
  $msg = $n.Output.ErrorInfo.Message; if ($msg) { $msg = ($msg -split "`n")[0..1] -join ' | ' }
  $out = $n.Output.StdOut
  "  RESULT testName='$($n.testName)' outcome=$($n.outcome)" + $(if($msg){" err='$msg'"}) + $(if($out){" stdout='$(($out -replace "`r?`n",' / '))'"})
}
foreach ($d in (Select-Xml -Xml $x -XPath '//t:UnitTest' -Namespace $ns)) {
  $tm = $d.Node.TestMethod
  "  DEF name='$($d.Node.name)' class='$($tm.className)' method='$($tm.name)'" + $(if($d.Node.TestCategory){" cats=" + (($d.Node.TestCategory.TestCategoryItem | % TestCategory) -join ',')})
}
$s = (Select-Xml -Xml $x -XPath '//t:ResultSummary' -Namespace $ns).Node
$c = $s.Counters
"  SUMMARY outcome=$($s.outcome) total=$($c.total) executed=$($c.executed) passed=$($c.passed) failed=$($c.failed) error=$($c.error)"
foreach ($ri in (Select-Xml -Xml $x -XPath '//t:RunInfo' -Namespace $ns)) { "  RUNINFO outcome=$($ri.Node.outcome) text='$(($ri.Node.Text -replace "`r?`n",' / '))'" }
if ($s.Output.StdOut) { "  SUMMARY-STDOUT '$($s.Output.StdOut -replace "`r?`n",' / ')'" }
