// Additional phase analysis of immutable recorded frames; no browser or app mutation.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { feedbackRegressions } from './loading-sequence-probe.mjs';
const output = resolve(process.argv[2]);
const reportPath = resolve(output, 'report.json'), report = JSON.parse(await readFile(reportPath, 'utf8'));
await writeFile(resolve(output, 'report-before-phase-analysis.json'), JSON.stringify(report, null, 2), { flag: 'wx' }).catch(error => { if(error.code !== 'EEXIST') throw error; });
for (const item of report.cases) {
  const trace = JSON.parse(await readFile(resolve(output, item.traceFile), 'utf8')); item.feedback = feedbackRegressions(trace.frames.filter(frame => frame.hash === '#' + item.route));
  if (item.feedback.neutralAfterSkeletonFrames.length) item.issues.push('neutral-loading-after-skeleton');
  if (item.feedback.simultaneousFeedbackFrames.length) item.issues.push('simultaneous-neutral-and-skeleton');
  if (item.feedback.skeletonEpisodes > 1) item.issues.push('skeleton-reappeared');
  item.issues = [...new Set(item.issues)];
}
report.consoleErrorsRecorded ??= false;
report.phaseAnalysis = { source: 'Recorded per-rAF traces; no replay or inferred intermediate frames.', closedDialogsExcluded: true };
report.summary = { journeys: report.cases.length, animationFrames: report.cases.reduce((n,c) => n + c.frames,0), journeysWithIssues: report.cases.filter(c => c.issues.length).length, multipleSkeletonJourneys: report.cases.filter(c => c.maxSkeletons > 1).length, maxSimultaneousSkeletons: Math.max(...report.cases.map(c => c.maxSkeletons)), shapeChangeJourneys: report.cases.filter(c => c.skeletonShapes > 1).length, repeatedNodeJourneys: report.cases.filter(c => c.skeletonNodes > 1).length, neutralReturnJourneys: report.cases.filter(c => c.feedback.neutralAfterSkeletonFrames.length).length, dualFeedbackJourneys: report.cases.filter(c => c.feedback.simultaneousFeedbackFrames.length).length, overflowJourneys: report.cases.filter(c => c.issues.includes('horizontal-overflow')).length, javascriptErrors: report.errors.length, consoleErrors: report.consoleErrorsRecorded ? report.consoleErrors.length : null, externalRequests: report.externalRequests.length };
report.passed = report.completed && report.summary.journeysWithIssues === 0 && report.errors.length === 0 && !(report.consoleErrors?.length) && report.externalRequests.length === 0;
await writeFile(reportPath, JSON.stringify(report,null,2)); console.log(JSON.stringify(report.summary));
