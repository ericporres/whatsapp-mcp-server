/**
 * Briefing Formatter
 *
 * Converts a ChatAnalysis into a formatted intelligence briefing.
 * Supports markdown and JSON output formats, with section toggles.
 */

import type {
  ChatAnalysis,
  CrossGroupSynthesis,
} from './analyzer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BriefingOptions {
  format?: 'markdown' | 'json';
  sections?: string[];
}

// ---------------------------------------------------------------------------
// Section Names (for toggles)
// ---------------------------------------------------------------------------

const ALL_SECTIONS = [
  'overview',
  'themes',
  'big-ideas',
  'opportunities',
  'strategic-signals',
  'participation',
  'live-threads',
  'notable-quotes',
  'action-items',
] as const;

type SectionName = (typeof ALL_SECTIONS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function formatDateRange(start: Date, end: Date): string {
  if (
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()
  ) {
    return formatDate(start);
  }
  return `${formatDate(start)} - ${formatDate(end)}`;
}

function sectionIncluded(
  section: SectionName,
  requested?: string[],
): boolean {
  if (!requested || requested.length === 0) return true;
  return requested.includes(section);
}

const DIVIDER = '\n\n';
const RULE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

// ---------------------------------------------------------------------------
// Section Renderers
// ---------------------------------------------------------------------------

function renderHeader(analysis: ChatAnalysis): string {
  const dateRange = formatDateRange(
    analysis.dateRange.start,
    analysis.dateRange.end,
  );
  return [
    RULE,
    'GROUP CHAT INTELLIGENCE BRIEFING',
    `${analysis.groupName} — ${dateRange}`,
    RULE,
  ].join('\n');
}

function renderOverview(analysis: ChatAnalysis): string {
  const lines = [
    'OVERVIEW',
    '',
    `Participants: ${analysis.participantCount}`,
    `Messages: ${analysis.messageVolume}`,
    `Period: ${formatDateRange(analysis.dateRange.start, analysis.dateRange.end)}`,
    `Themes identified: ${analysis.themes.length}`,
    `Opportunities flagged: ${analysis.opportunities.length}`,
    `Your participation: ${analysis.participation.percentage}% (${analysis.participation.level})`,
  ];
  return lines.join('\n');
}

function renderThemes(analysis: ChatAnalysis): string {
  if (analysis.themes.length === 0) {
    return 'KEY THEMES\n\nNo significant themes identified.';
  }

  const lines = [`KEY THEMES (${analysis.themes.length} identified)`];

  for (let i = 0; i < analysis.themes.length; i++) {
    const t = analysis.themes[i];
    const tag =
      t.recurrence === 'hot'
        ? 'HOT'
        : t.recurrence === 'important'
          ? 'IMPORTANT'
          : 'EMERGING';

    lines.push('');
    lines.push(`${i + 1}. ${t.name} [${tag}]`);
    lines.push(`   ${t.summary}`);
    lines.push(`   Contributors: ${t.contributors.join(', ')}`);
    lines.push(`   Messages: ${t.messageCount}`);
  }

  return lines.join('\n');
}

function renderBigIdeas(analysis: ChatAnalysis): string {
  if (analysis.bigIdeas.length === 0) {
    return 'BIG IDEAS WORTH CAPTURING\n\nNo standout ideas detected.';
  }

  const lines = [
    `BIG IDEAS WORTH CAPTURING (${analysis.bigIdeas.length})`,
  ];

  for (let i = 0; i < analysis.bigIdeas.length; i++) {
    const idea = analysis.bigIdeas[i];
    lines.push('');
    lines.push(`${i + 1}. "${idea.idea}"`);
    lines.push(`   — ${idea.author}`);
    lines.push(`   Relevance: ${idea.relevance}`);
    if (idea.flags.length > 0) {
      lines.push(`   Flags: ${idea.flags.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function renderOpportunities(analysis: ChatAnalysis): string {
  if (analysis.opportunities.length === 0) {
    return 'OPPORTUNITIES FOR YOU\n\nNo actionable opportunities detected.';
  }

  const lines = [
    `OPPORTUNITIES FOR YOU (${analysis.opportunities.length})`,
  ];

  for (const opp of analysis.opportunities) {
    lines.push('');
    lines.push(`OPPORTUNITY — ${opp.type.toUpperCase()}`);
    lines.push(opp.description);
    lines.push(`Suggested action: ${opp.suggestedAction}`);
  }

  return lines.join('\n');
}

function renderStrategicSignals(analysis: ChatAnalysis): string {
  const lines = ['STRATEGIC SIGNALS'];

  // Product relevance (customize flag names in analyzer.ts)
  const productIdeas = analysis.bigIdeas.filter((i) =>
    i.flags.includes('product-relevant'),
  );
  const enterpriseIdeas = analysis.bigIdeas.filter((i) =>
    i.flags.includes('enterprise-ai'),
  );
  const contentIdeas = analysis.bigIdeas.filter((i) =>
    i.flags.includes('content-pipeline'),
  );
  const businessLeads = analysis.opportunities.filter(
    (o) => o.type === 'business-lead',
  );

  lines.push('');
  lines.push('Product Relevance:');
  if (productIdeas.length > 0 || businessLeads.length > 0) {
    if (productIdeas.length > 0) {
      lines.push(
        `  ${productIdeas.length} idea(s) flagged as product-relevant`,
      );
      for (const idea of productIdeas.slice(0, 3)) {
        const snippet =
          idea.idea.length > 100
            ? idea.idea.slice(0, 100) + '...'
            : idea.idea;
        lines.push(`  - ${idea.author}: "${snippet}"`);
      }
    }
    if (businessLeads.length > 0) {
      lines.push(
        `  ${businessLeads.length} potential business lead(s) detected`,
      );
    }
  } else {
    lines.push('  No direct product signals in this batch.');
  }

  lines.push('');
  lines.push('Content Pipeline:');
  if (contentIdeas.length > 0) {
    for (const idea of contentIdeas.slice(0, 3)) {
      const hook =
        idea.idea.length > 80 ? idea.idea.slice(0, 80) + '...' : idea.idea;
      lines.push(`  Content hook: "${hook}"`);
    }
  } else if (analysis.bigIdeas.length > 0) {
    // Suggest top idea as content
    const topIdea = analysis.bigIdeas[0];
    const hook =
      topIdea.idea.length > 80
        ? topIdea.idea.slice(0, 80) + '...'
        : topIdea.idea;
    lines.push(`  Consider exploring: "${hook}" (from ${topIdea.author})`);
  } else {
    lines.push('  No content hooks identified.');
  }

  lines.push('');
  lines.push('Competitive Intelligence:');
  if (enterpriseIdeas.length > 0) {
    lines.push(
      `  ${enterpriseIdeas.length} enterprise AI signal(s) worth tracking`,
    );
    for (const idea of enterpriseIdeas.slice(0, 3)) {
      const snippet =
        idea.idea.length > 100
          ? idea.idea.slice(0, 100) + '...'
          : idea.idea;
      lines.push(`  - ${snippet}`);
    }
  } else {
    lines.push('  No competitive signals detected.');
  }

  return lines.join('\n');
}

function renderParticipation(analysis: ChatAnalysis): string {
  const p = analysis.participation;
  const lines = ['YOUR PARTICIPATION'];

  lines.push('');
  lines.push(`Level: ${p.level.charAt(0).toUpperCase() + p.level.slice(1)}`);
  lines.push(`Messages: ${p.messageCount} of ${analysis.messageVolume} (${p.percentage}%)`);

  if (p.topicsEngaged.length > 0) {
    lines.push(`Topics engaged: ${p.topicsEngaged.join(', ')}`);
  }
  if (p.topicsSkipped.length > 0) {
    lines.push(`Topics skipped: ${p.topicsSkipped.join(', ')}`);
  }

  if (p.missedOpportunities.length > 0) {
    lines.push('');
    lines.push('Missed opportunities:');
    for (const missed of p.missedOpportunities) {
      lines.push(`  - ${missed}`);
    }
  }

  // Constructive suggestion
  lines.push('');
  if (p.level === 'listening') {
    lines.push(
      'Focus suggestion: You are mostly consuming in this group. Consider weighing in on topics where your expertise adds value — even a brief perspective keeps you visible and builds influence.',
    );
  } else if (p.level === 'moderate') {
    lines.push(
      'Focus suggestion: Solid engagement. Look for threads where you can add unique perspective from your enterprise AI experience to deepen your impact.',
    );
  } else {
    lines.push(
      'Focus suggestion: Strong presence. Make sure your contributions are strategic — prioritize threads where your voice has the most impact.',
    );
  }

  return lines.join('\n');
}

function renderLiveThreads(analysis: ChatAnalysis): string {
  if (analysis.liveThreads.length === 0) {
    return 'LIVE THREADS — Jump in?\n\nNo active threads requiring your input.';
  }

  const lines = [
    `LIVE THREADS — Jump in? (${analysis.liveThreads.length})`,
  ];

  for (let i = 0; i < analysis.liveThreads.length; i++) {
    const thread = analysis.liveThreads[i];
    lines.push('');
    lines.push(`LIVE THREAD ${i + 1}`);
    lines.push(`Topic: ${thread.topic}`);
    lines.push(`Status: ${thread.status}`);
    lines.push(`Participants: ${thread.participants.join(', ')}`);
    lines.push(`Your angle: ${thread.userAngle}`);
    lines.push(`Suggested message: "${thread.suggestedMessage}"`);
  }

  return lines.join('\n');
}

function renderNotableQuotes(analysis: ChatAnalysis): string {
  if (analysis.notableQuotes.length === 0) {
    return 'NOTABLE QUOTES\n\nNo standout quotes identified.';
  }

  const lines = ['NOTABLE QUOTES'];

  for (const q of analysis.notableQuotes) {
    lines.push('');
    lines.push(`"${q.quote}"`);
    lines.push(`  — ${q.author}`);
  }

  return lines.join('\n');
}

function renderActionItems(analysis: ChatAnalysis): string {
  const items: string[] = [];
  let counter = 1;

  // NOW: live threads to jump into
  for (const thread of analysis.liveThreads) {
    items.push(
      `${counter}. [NOW] Reply to thread about ${thread.topic}`,
    );
    items.push(`   Draft: "${thread.suggestedMessage}"`);
    items.push('');
    counter++;
  }

  // THIS WEEK: high-priority opportunities
  const highPriorityTypes = ['collaboration', 'business-lead', 'speaking'];
  const highPriority = analysis.opportunities.filter((o) =>
    highPriorityTypes.includes(o.type),
  );
  for (const opp of highPriority.slice(0, 5)) {
    items.push(
      `${counter}. [THIS WEEK] ${opp.suggestedAction}`,
    );
    items.push(`   Context: ${opp.description.slice(0, 150)}`);
    items.push('');
    counter++;
  }

  // WHEN CONVENIENT: content ideas, learning, networking
  const lowerPriorityTypes = ['learning', 'networking', 'connection'];
  const lowerPriority = analysis.opportunities.filter((o) =>
    lowerPriorityTypes.includes(o.type),
  );
  for (const opp of lowerPriority.slice(0, 3)) {
    items.push(
      `${counter}. [WHEN CONVENIENT] ${opp.suggestedAction}`,
    );
    items.push(`   Context: ${opp.description.slice(0, 150)}`);
    items.push('');
    counter++;
  }

  // Content pipeline items from big ideas
  const contentIdeas = analysis.bigIdeas.filter(
    (i) =>
      i.flags.includes('content-pipeline') || i.flags.includes('enterprise-ai'),
  );
  for (const idea of contentIdeas.slice(0, 2)) {
    const hook =
      idea.idea.length > 80 ? idea.idea.slice(0, 80) + '...' : idea.idea;
    items.push(
      `${counter}. [WHEN CONVENIENT] Explore as newsletter/blog post: "${hook}"`,
    );
    items.push(`   Source: ${idea.author}`);
    items.push('');
    counter++;
  }

  if (items.length === 0) {
    return 'ACTION ITEMS\n\nNo immediate action items identified.';
  }

  return ['ACTION ITEMS', '', ...items].join('\n');
}

// ---------------------------------------------------------------------------
// Main Formatter
// ---------------------------------------------------------------------------

export function formatBriefing(
  analysis: ChatAnalysis,
  options?: BriefingOptions,
): string {
  const format = options?.format ?? 'markdown';
  const sections = options?.sections;

  if (format === 'json') {
    return JSON.stringify(
      analysis,
      (key, value) => {
        // Serialize Date objects as ISO strings
        if (value instanceof Date) {
          return value.toISOString();
        }
        return value;
      },
      2,
    );
  }

  // Markdown format
  const parts: string[] = [];

  parts.push(renderHeader(analysis));

  if (sectionIncluded('overview', sections)) {
    parts.push(renderOverview(analysis));
  }

  if (sectionIncluded('themes', sections)) {
    parts.push(renderThemes(analysis));
  }

  if (sectionIncluded('big-ideas', sections)) {
    parts.push(renderBigIdeas(analysis));
  }

  if (sectionIncluded('opportunities', sections)) {
    parts.push(renderOpportunities(analysis));
  }

  if (sectionIncluded('strategic-signals', sections)) {
    parts.push(renderStrategicSignals(analysis));
  }

  if (sectionIncluded('participation', sections)) {
    parts.push(renderParticipation(analysis));
  }

  if (sectionIncluded('live-threads', sections)) {
    parts.push(renderLiveThreads(analysis));
  }

  if (sectionIncluded('notable-quotes', sections)) {
    parts.push(renderNotableQuotes(analysis));
  }

  if (sectionIncluded('action-items', sections)) {
    parts.push(renderActionItems(analysis));
  }

  parts.push(RULE);

  return parts.join(DIVIDER);
}

// ---------------------------------------------------------------------------
// Cross-Group Synthesis Formatter
// ---------------------------------------------------------------------------

export function formatCrossGroupSynthesis(
  synthesis: CrossGroupSynthesis,
): string {
  const parts: string[] = [];

  parts.push(RULE);
  parts.push(
    `CROSS-GROUP SYNTHESIS (${synthesis.groupCount} groups analyzed)`,
  );
  parts.push(
    `Groups: ${synthesis.groupNames.join(', ')}`,
  );
  parts.push(RULE);

  // Amplified Signals
  if (synthesis.amplifiedSignals.length > 0) {
    const lines = ['AMPLIFIED SIGNALS (themes in 2+ groups)'];
    for (const signal of synthesis.amplifiedSignals) {
      lines.push('');
      lines.push(`${signal.theme} — appeared in ${signal.groups.join(', ')}`);
      lines.push(signal.significance);
    }
    parts.push(lines.join('\n'));
  }

  // Network Nodes
  if (synthesis.networkNodes.length > 0) {
    const lines = ['NETWORK NODES'];
    for (const node of synthesis.networkNodes) {
      lines.push('');
      lines.push(`${node.person} — active in ${node.groups.join(', ')}`);
      lines.push(node.role);
    }
    parts.push(lines.join('\n'));
  }

  // Compounding Opportunities
  if (synthesis.compoundingOpportunities.length > 0) {
    const lines = ['COMPOUNDING OPPORTUNITIES'];
    for (const opp of synthesis.compoundingOpportunities) {
      lines.push('');
      lines.push(opp.opportunity);
      for (const ctx of opp.contexts) {
        lines.push(`  ${ctx.group}: ${ctx.detail}`);
      }
      lines.push(`  Bigger play: ${opp.biggerPlay}`);
    }
    parts.push(lines.join('\n'));
  }

  // Divergent Perspectives
  if (synthesis.divergentPerspectives.length > 0) {
    const lines = ['DIVERGENT PERSPECTIVES'];
    for (const div of synthesis.divergentPerspectives) {
      lines.push('');
      lines.push(`Topic: ${div.topic}`);
      for (const p of div.perspectives) {
        lines.push(`  ${p.group}: ${p.stance}`);
      }
    }
    parts.push(lines.join('\n'));
  }

  parts.push(RULE);

  return parts.join(DIVIDER);
}
