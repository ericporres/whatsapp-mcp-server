/**
 * Chat Intelligence Analyzer
 *
 * Analyzes parsed chat messages to extract themes, big ideas, opportunities,
 * participation metrics, live threads, and notable quotes.
 *
 * Customize EXAMPLE_CONTEXT below with your own professional context.
 */

// ---------------------------------------------------------------------------
// Types — ParsedMessage mirrors the parser output contract
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  platform: string;
  timestamp: Date;
  author: string;
  body: string;
  isMedia: boolean;
  isSystem: boolean;
}

// ---------------------------------------------------------------------------
// User Context
// ---------------------------------------------------------------------------

export interface UserContext {
  name: string;
  aliases: string[];
  role: string;
  focusAreas: string[];
  opportunityTypes: string[];
  contentOutlets: string[];
}

/**
 * CUSTOMIZE THIS with your own professional context.
 * The analyzer uses these fields to detect relevant opportunities,
 * flag ideas that connect to your work, and assess your participation.
 */
export const EXAMPLE_CONTEXT: UserContext = {
  name: 'Your Name',
  aliases: ['YourName', 'yourname', 'YN'],
  role: 'Your role and company',
  focusAreas: [
    'your focus area 1',
    'your focus area 2',
    'your product or platform',
    'your domain expertise',
  ],
  opportunityTypes: [
    'partnerships',
    'speaking',
    'pain points your product solves',
    'content ideas',
    'peer collaboration',
  ],
  contentOutlets: ['Your Newsletter', 'LinkedIn'],
};

// ---------------------------------------------------------------------------
// Analysis Result Types
// ---------------------------------------------------------------------------

export interface Theme {
  name: string;
  summary: string;
  contributors: string[];
  recurrence: 'hot' | 'important' | 'emerging';
  messageCount: number;
}

export interface BigIdea {
  idea: string;
  author: string;
  relevance: string;
  flags: string[];
}

export interface Opportunity {
  type: string;
  description: string;
  suggestedAction: string;
  group?: string;
}

export interface ParticipationAnalysis {
  messageCount: number;
  percentage: number;
  level: 'active' | 'moderate' | 'listening';
  topicsEngaged: string[];
  topicsSkipped: string[];
  missedOpportunities: string[];
}

export interface LiveThread {
  topic: string;
  status: string;
  participants: string[];
  userAngle: string;
  suggestedMessage: string;
}

export interface ChatAnalysis {
  groupName: string;
  dateRange: { start: Date; end: Date };
  participantCount: number;
  messageVolume: number;
  themes: Theme[];
  bigIdeas: BigIdea[];
  opportunities: Opportunity[];
  participation: ParticipationAnalysis;
  liveThreads: LiveThread[];
  notableQuotes: { quote: string; author: string }[];
}

export interface CrossGroupSynthesis {
  groupCount: number;
  groupNames: string[];
  amplifiedSignals: {
    theme: string;
    groups: string[];
    significance: string;
  }[];
  networkNodes: {
    person: string;
    groups: string[];
    role: string;
  }[];
  compoundingOpportunities: {
    opportunity: string;
    contexts: { group: string; detail: string }[];
    biggerPlay: string;
  }[];
  divergentPerspectives: {
    topic: string;
    perspectives: { group: string; stance: string }[];
  }[];
}

// ---------------------------------------------------------------------------
// Stop-Words — filtered out of keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'was', 'are',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'not', 'no', 'so', 'if', 'then', 'than', 'too', 'very', 'just',
  'about', 'up', 'out', 'as', 'into', 'its', 'my', 'your', 'our',
  'his', 'her', 'their', 'we', 'they', 'he', 'she', 'you', 'i', 'me',
  'him', 'us', 'them', 'what', 'which', 'who', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
  'also', 'here', 'there', 'now', 'well', 'way', 'because', 'even',
  'get', 'got', 'go', 'going', 'come', 'came', 'make', 'made', 'take',
  'took', 'know', 'think', 'see', 'look', 'like', 'want', 'give',
  'use', 'find', 'tell', 'say', 'said', 'one', 'two', 'new', 'good',
  'right', 'yeah', 'yes', 'ok', 'okay', 'sure', 'thanks', 'thank',
  'lol', 'haha', 'ha', 'oh', 'hey', 'hi', 'hello', 'really', 'much',
  'many', 'still', 'back', 'only', 'don', 'doesn', 'didn', 'won',
  'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'wouldn', 'couldn',
  'shouldn', 've', 'll', 're', 'let', 'need', 'over', 'own', 'same',
  'through', 'after', 'before', 'between', 'under', 'again', 'other',
  'another', 'such', 'while', 'doing', 'during', 'thing', 'things',
  'something', 'nothing', 'everything', 'anything', 'already', 'always',
  'never', 'ever', 'maybe', 'keep', 'put', 'end', 'next', 'big',
  'small', 'long', 'great', 'different', 'first', 'last', 'around',
  'actually', 'pretty', 'lot', 'kind', 'able', 'try', 'though',
  'might', 'work', 'people', 'time', 'day', 'point', 'part',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize a message body into lowercase words, stripping punctuation. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '') // strip URLs
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Check whether an author matches the user context (name or aliases). */
function isUser(author: string, ctx: UserContext): boolean {
  const lower = author.toLowerCase();
  if (lower === ctx.name.toLowerCase()) return true;
  return ctx.aliases.some((a) => lower === a.toLowerCase() || lower.startsWith(a.toLowerCase()));
}

/** Extract links from message body. */
function extractLinks(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  return text.match(urlRegex) ?? [];
}

/** Calculate term frequency across a corpus, returning a Map of word -> count. */
function termFrequency(messages: ParsedMessage[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const msg of messages) {
    const words = tokenize(msg.body);
    const seen = new Set<string>(); // count each word once per message for DF
    for (const w of words) {
      if (!seen.has(w)) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
        seen.add(w);
      }
    }
  }
  return freq;
}

/** Score a word using a TF-IDF-like metric: high doc frequency but not universal. */
function significantTerms(
  docFreq: Map<string, number>,
  totalDocs: number,
  minDf: number = 3,
  maxDfRatio: number = 0.6,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [word, df] of docFreq) {
    const ratio = df / totalDocs;
    if (df >= minDf && ratio <= maxDfRatio) {
      // TF-IDF inspired: words appearing in a meaningful fraction score higher
      const idf = Math.log(totalDocs / df);
      scores.set(word, df * idf);
    }
  }
  return scores;
}

/** Group messages into time-based clusters (windows of `windowMinutes`). */
function clusterByTime(
  messages: ParsedMessage[],
  windowMinutes: number = 30,
): ParsedMessage[][] {
  if (messages.length === 0) return [];
  const sorted = [...messages].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );
  const clusters: ParsedMessage[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const gap =
      (sorted[i].timestamp.getTime() -
        sorted[i - 1].timestamp.getTime()) /
      60000;
    if (gap <= windowMinutes) {
      clusters[clusters.length - 1].push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters;
}

/** Check if text contains any of the given keywords (case-insensitive). */
function containsKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

/** Determine the most prominent keyword-cluster label from a set of messages. */
function labelCluster(messages: ParsedMessage[], topTerms: Map<string, number>): string {
  const clusterFreq = new Map<string, number>();
  for (const msg of messages) {
    for (const w of tokenize(msg.body)) {
      if (topTerms.has(w)) {
        clusterFreq.set(w, (clusterFreq.get(w) ?? 0) + 1);
      }
    }
  }
  const sorted = [...clusterFreq.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length >= 2) {
    return `${capitalize(sorted[0][0])} & ${capitalize(sorted[1][0])}`;
  }
  if (sorted.length === 1) {
    return capitalize(sorted[0][0]);
  }
  // Fallback: use the most common non-stop word
  const fallback = new Map<string, number>();
  for (const msg of messages) {
    for (const w of tokenize(msg.body)) {
      fallback.set(w, (fallback.get(w) ?? 0) + 1);
    }
  }
  const top = [...fallback.entries()].sort((a, b) => b[1] - a[1]);
  return top.length > 0 ? capitalize(top[0][0]) : 'General Discussion';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Summarize a cluster of messages into a 2-3 sentence summary. */
function summarizeCluster(messages: ParsedMessage[]): string {
  // Pick the longest non-media message as the representative, then condense
  const contentMsgs = messages.filter((m) => !m.isMedia && !m.isSystem && m.body.length > 20);
  if (contentMsgs.length === 0) {
    return 'Brief exchanges with no substantive content.';
  }
  const sorted = [...contentMsgs].sort((a, b) => b.body.length - a.body.length);
  const representative = sorted[0];
  const uniqueAuthors = new Set(messages.map((m) => m.author));
  const snippet =
    representative.body.length > 200
      ? representative.body.slice(0, 200) + '...'
      : representative.body;
  return `${uniqueAuthors.size} participants discussed this topic. Key point from ${representative.author}: "${snippet}"`;
}

// ---------------------------------------------------------------------------
// Theme Extraction
// ---------------------------------------------------------------------------

function extractThemes(
  messages: ParsedMessage[],
  topTerms: Map<string, number>,
): Theme[] {
  // Cluster messages by keyword co-occurrence
  // Step 1: build keyword vectors for each message
  const contentMessages = messages.filter(
    (m) => !m.isMedia && !m.isSystem && m.body.length > 10,
  );

  if (contentMessages.length === 0) return [];

  const topKeywords = [...topTerms.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([word]) => word);

  // Step 2: group messages by their dominant keyword
  const keywordGroups = new Map<string, ParsedMessage[]>();
  for (const msg of contentMessages) {
    const words = tokenize(msg.body);
    let bestKeyword = '';
    let bestScore = 0;
    for (const kw of topKeywords) {
      if (words.includes(kw)) {
        const score = topTerms.get(kw) ?? 0;
        if (score > bestScore) {
          bestScore = score;
          bestKeyword = kw;
        }
      }
    }
    if (bestKeyword) {
      const group = keywordGroups.get(bestKeyword) ?? [];
      group.push(msg);
      keywordGroups.set(bestKeyword, group);
    }
  }

  // Step 3: merge related keyword groups (keywords that co-occur often)
  const mergedGroups: { keywords: string[]; messages: ParsedMessage[] }[] = [];
  const assigned = new Set<string>();

  const groupEntries = [...keywordGroups.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  for (const [kw, msgs] of groupEntries) {
    if (assigned.has(kw)) continue;
    const cluster = { keywords: [kw], messages: [...msgs] };
    assigned.add(kw);

    // Find co-occurring keywords
    for (const [otherKw, otherMsgs] of groupEntries) {
      if (assigned.has(otherKw)) continue;
      const overlap = msgs.filter((m) =>
        otherMsgs.some((om) => om === m),
      ).length;
      const overlapRatio = overlap / Math.min(msgs.length, otherMsgs.length);
      if (overlapRatio > 0.3 || (overlap > 2 && otherMsgs.length < 8)) {
        cluster.keywords.push(otherKw);
        cluster.messages.push(
          ...otherMsgs.filter((om) => !cluster.messages.includes(om)),
        );
        assigned.add(otherKw);
      }
    }

    if (cluster.messages.length >= 2) {
      mergedGroups.push(cluster);
    }
  }

  // Step 4: produce Theme objects, capped at 7
  const themes: Theme[] = mergedGroups.slice(0, 7).map((group) => {
    const contributors = [
      ...new Set(group.messages.map((m) => m.author)),
    ];
    const msgCount = group.messages.length;
    const totalMessages = contentMessages.length;
    const ratio = msgCount / totalMessages;

    let recurrence: 'hot' | 'important' | 'emerging';
    if (ratio > 0.15) {
      recurrence = 'hot';
    } else if (ratio > 0.07) {
      recurrence = 'important';
    } else {
      recurrence = 'emerging';
    }

    return {
      name: labelCluster(group.messages, topTerms),
      summary: summarizeCluster(group.messages),
      contributors,
      recurrence,
      messageCount: msgCount,
    };
  });

  // Ensure at least 3 themes if we have enough messages
  if (themes.length < 3 && contentMessages.length > 20) {
    // Use time-based clusters as fallback themes
    const timeClusters = clusterByTime(contentMessages, 60);
    const largeClusters = timeClusters
      .filter((c) => c.length >= 3)
      .sort((a, b) => b.length - a.length);

    for (const cluster of largeClusters) {
      if (themes.length >= 3) break;
      const label = labelCluster(cluster, topTerms);
      if (!themes.some((t) => t.name === label)) {
        themes.push({
          name: label,
          summary: summarizeCluster(cluster),
          contributors: [...new Set(cluster.map((m) => m.author))],
          recurrence: 'emerging',
          messageCount: cluster.length,
        });
      }
    }
  }

  return themes;
}

// ---------------------------------------------------------------------------
// Big Idea Detection
// ---------------------------------------------------------------------------

function detectBigIdeas(
  messages: ParsedMessage[],
  ctx: UserContext,
): BigIdea[] {
  const contentMessages = messages.filter(
    (m) => !m.isMedia && !m.isSystem && m.body.length > 10,
  );
  if (contentMessages.length === 0) return [];

  const avgLength =
    contentMessages.reduce((sum, m) => sum + m.body.length, 0) /
    contentMessages.length;

  // Build a reply map: messages that got replied to (heuristic: same author
  // mentioned, or temporal proximity with address pattern)
  const replyScores = new Map<number, number>();
  for (let i = 0; i < contentMessages.length; i++) {
    replyScores.set(i, 0);
  }

  // Score: look at messages within 10 minutes that reference previous content
  for (let i = 1; i < contentMessages.length; i++) {
    const curr = contentMessages[i];
    for (let j = Math.max(0, i - 5); j < i; j++) {
      const prev = contentMessages[j];
      const gap =
        (curr.timestamp.getTime() - prev.timestamp.getTime()) / 60000;
      if (gap <= 10 && gap >= 0) {
        // If current message references words from previous, count as reply
        const prevWords = new Set(tokenize(prev.body));
        const currWords = tokenize(curr.body);
        const overlap = currWords.filter((w) => prevWords.has(w)).length;
        if (overlap >= 2) {
          replyScores.set(j, (replyScores.get(j) ?? 0) + 1);
        }
      }
    }
  }

  // Score each message
  const scored: { msg: ParsedMessage; index: number; score: number }[] = [];
  for (let i = 0; i < contentMessages.length; i++) {
    const msg = contentMessages[i];
    let score = 0;

    // Length bonus: messages longer than 2x average get points
    if (msg.body.length > avgLength * 2) {
      score += 3;
    } else if (msg.body.length > avgLength * 1.5) {
      score += 2;
    } else if (msg.body.length > avgLength) {
      score += 1;
    }

    // Contains links
    if (extractLinks(msg.body).length > 0) {
      score += 2;
    }

    // Gets replies
    score += (replyScores.get(i) ?? 0) * 2;

    // Declarative language patterns
    const declarativePatterns = [
      /\bi think\b/i,
      /\bwe should\b/i,
      /\bwe need\b/i,
      /\bthe key is\b/i,
      /\bthe problem is\b/i,
      /\bthe opportunity\b/i,
      /\bwhat if\b/i,
      /\bhere's my take\b/i,
      /\bmy view\b/i,
      /\bthe real issue\b/i,
      /\bfundamentally\b/i,
      /\bstrategically\b/i,
      /\bthe future of\b/i,
      /\bthe challenge\b/i,
      /\bin my experience\b/i,
      /\bthe lesson\b/i,
      /\bhere's what\b/i,
    ];
    for (const pattern of declarativePatterns) {
      if (pattern.test(msg.body)) {
        score += 1;
      }
    }

    // Relevance to user focus areas
    const matchedFocus = containsKeywords(msg.body, ctx.focusAreas);
    score += matchedFocus.length;

    if (score >= 3) {
      scored.push({ msg, index: i, score });
    }
  }

  // Sort by score, take top 10
  scored.sort((a, b) => b.score - a.score);
  const topIdeas = scored.slice(0, 10);

  return topIdeas.map(({ msg }) => {
    const matchedFocus = containsKeywords(msg.body, ctx.focusAreas);
    const flags: string[] = [];
    // Flag ideas that relate to your product/platform (customize these keywords)
    if (
      containsKeywords(msg.body, ctx.focusAreas.slice(0, 3))
    ) {
      flags.push('product-relevant');
    }
    if (
      msg.body.toLowerCase().includes('content') ||
      msg.body.toLowerCase().includes('substack') ||
      msg.body.toLowerCase().includes('newsletter') ||
      msg.body.toLowerCase().includes('blog')
    ) {
      flags.push('content-pipeline');
    }
    if (
      msg.body.toLowerCase().includes('enterprise') ||
      msg.body.toLowerCase().includes('governance') ||
      msg.body.toLowerCase().includes('adoption') ||
      msg.body.toLowerCase().includes('ai strategy')
    ) {
      flags.push('enterprise-ai');
    }

    const ideaText =
      msg.body.length > 300 ? msg.body.slice(0, 300) + '...' : msg.body;

    const relevanceParts: string[] = [];
    if (matchedFocus.length > 0) {
      relevanceParts.push(`Touches on: ${matchedFocus.join(', ')}`);
    }
    if (flags.length > 0) {
      relevanceParts.push(`Flagged for: ${flags.join(', ')}`);
    }
    if (relevanceParts.length === 0) {
      relevanceParts.push('General insight worth noting');
    }

    return {
      idea: ideaText,
      author: msg.author,
      relevance: relevanceParts.join('. '),
      flags,
    };
  });
}

// ---------------------------------------------------------------------------
// Opportunity Detection
// ---------------------------------------------------------------------------

function detectOpportunities(
  messages: ParsedMessage[],
  ctx: UserContext,
  groupName: string,
): Opportunity[] {
  const opportunities: Opportunity[] = [];
  const contentMessages = messages.filter(
    (m) => !m.isMedia && !m.isSystem && m.body.length > 15,
  );

  // Pattern definitions for opportunity types
  const opportunityPatterns: {
    type: string;
    patterns: RegExp[];
    keywords: string[];
  }[] = [
    {
      type: 'collaboration',
      patterns: [
        /looking for (someone|people|help|partner)/i,
        /anyone (interested|working on|know)/i,
        /let'?s collaborate/i,
        /open to (working|partnering|teaming)/i,
        /need (someone|help|a partner|expertise)/i,
        /who (wants to|can help|is working on)/i,
      ],
      keywords: ['collaborate', 'partner', 'joint', 'together', 'co-create'],
    },
    {
      type: 'business-lead',
      patterns: [
        /looking for (a tool|a platform|a solution|software)/i,
        /we need (a system|an AI|a platform)/i,
        /evaluating (vendors|tools|platforms|solutions)/i,
        /pain point/i,
        /struggling with/i,
        /frustrated (with|by)/i,
        /anyone (recommend|suggest|use)/i,
      ],
      keywords: [
        'enterprise',
        'platform',
        'solution',
        'vendor',
        'procurement',
        'budget',
        'ROI',
        'implementation',
      ],
    },
    {
      type: 'speaking',
      patterns: [
        /looking for (speakers|panelists|presenters)/i,
        /speaking (slot|opportunity|engagement)/i,
        /conference|summit|event|webinar/i,
        /call for (papers|proposals|speakers)/i,
        /keynote/i,
        /panel discussion/i,
      ],
      keywords: ['conference', 'summit', 'keynote', 'panel', 'presentation', 'speaking'],
    },
    {
      type: 'connection',
      patterns: [
        /intro(duce|duction)? to/i,
        /do you know (anyone|someone)/i,
        /can (anyone|someone) connect me/i,
        /would love to meet/i,
        /should (meet|talk to|connect with)/i,
      ],
      keywords: ['introduction', 'connect', 'network', 'meet'],
    },
    {
      type: 'learning',
      patterns: [
        /great (article|book|resource|paper|talk|podcast)/i,
        /recommend (reading|watching|listening)/i,
        /just (read|watched|listened|learned)/i,
        /check (this|it) out/i,
        /worth (reading|watching|your time)/i,
      ],
      keywords: ['research', 'study', 'framework', 'methodology', 'paper'],
    },
    {
      type: 'networking',
      patterns: [
        /meetup|dinner|drinks|lunch|coffee/i,
        /anyone (in|near|around) (SF|NYC|London|LA)/i,
        /getting together/i,
        /in-person/i,
        /who'?s (going|attending|at)/i,
      ],
      keywords: ['meetup', 'dinner', 'event', 'gathering'],
    },
  ];

  for (const msg of contentMessages) {
    // Skip user's own messages for opportunity detection
    if (isUser(msg.author, ctx)) continue;

    for (const opType of opportunityPatterns) {
      const patternMatch = opType.patterns.some((p) => p.test(msg.body));
      const keywordMatches = containsKeywords(msg.body, opType.keywords);
      const focusMatches = containsKeywords(msg.body, ctx.focusAreas);

      if (patternMatch || (keywordMatches.length >= 2 && focusMatches.length > 0)) {
        const snippet =
          msg.body.length > 200
            ? msg.body.slice(0, 200) + '...'
            : msg.body;

        opportunities.push({
          type: opType.type,
          description: `${msg.author}: "${snippet}"`,
          suggestedAction: generateSuggestedAction(opType.type, msg, ctx),
          group: groupName,
        });
        break; // one opportunity type per message
      }
    }
  }

  // Detect missed contribution opportunities
  // Find threads on user's focus areas where user is absent
  const userMessages = contentMessages.filter((m) => isUser(m.author, ctx));
  const userTopics = new Set<string>();
  for (const m of userMessages) {
    for (const fa of ctx.focusAreas) {
      if (m.body.toLowerCase().includes(fa.toLowerCase())) {
        userTopics.add(fa);
      }
    }
  }

  const timeClusters = clusterByTime(contentMessages, 30);
  for (const cluster of timeClusters) {
    if (cluster.length < 3) continue;
    const hasUser = cluster.some((m) => isUser(m.author, ctx));
    if (hasUser) continue;

    const clusterText = cluster.map((m) => m.body).join(' ');
    const relevantFocus = containsKeywords(clusterText, ctx.focusAreas);
    if (relevantFocus.length > 0) {
      const participants = [...new Set(cluster.map((m) => m.author))];
      opportunities.push({
        type: 'missed-contribution',
        description: `Discussion about ${relevantFocus.join(', ')} among ${participants.slice(0, 3).join(', ')}${participants.length > 3 ? ' and others' : ''} — you weren't part of this conversation.`,
        suggestedAction: `Review the thread and consider weighing in with your perspective on ${relevantFocus[0]}.`,
        group: groupName,
      });
    }
  }

  // De-duplicate: cap at 15 opportunities, prioritize diversity of types
  const byType = new Map<string, Opportunity[]>();
  for (const opp of opportunities) {
    const list = byType.get(opp.type) ?? [];
    list.push(opp);
    byType.set(opp.type, list);
  }

  const deduped: Opportunity[] = [];
  let round = 0;
  while (deduped.length < 15) {
    let added = false;
    for (const [, list] of byType) {
      if (round < list.length && deduped.length < 15) {
        deduped.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }

  return deduped;
}

function generateSuggestedAction(
  type: string,
  msg: ParsedMessage,
  ctx: UserContext,
): string {
  switch (type) {
    case 'collaboration':
      return `Reach out to ${msg.author} — your experience with ${ctx.focusAreas[0]} could be a strong fit.`;
    case 'business-lead':
      return `Flag for outreach. ${msg.author} may be evaluating solutions where your product fits.`;
    case 'speaking':
      return `Express interest to ${msg.author}. Your perspective on ${ctx.focusAreas[0]} and ${ctx.focusAreas[1]} would add value.`;
    case 'connection':
      return `Consider making the introduction if you know the right person, or offer your own expertise.`;
    case 'learning':
      return `Check out what ${msg.author} shared. May be worth referencing in ${ctx.contentOutlets[0]}.`;
    case 'networking':
      return `Consider attending if the timing works. Good opportunity to deepen connection with ${msg.author}.`;
    default:
      return `Follow up with ${msg.author} on this.`;
  }
}

// ---------------------------------------------------------------------------
// Participation Analysis
// ---------------------------------------------------------------------------

function analyzeParticipation(
  messages: ParsedMessage[],
  ctx: UserContext,
  themes: Theme[],
): ParticipationAnalysis {
  const contentMessages = messages.filter((m) => !m.isSystem);
  const userMessages = contentMessages.filter((m) => isUser(m.author, ctx));
  const totalCount = contentMessages.length;
  const userCount = userMessages.length;
  const percentage = totalCount > 0 ? (userCount / totalCount) * 100 : 0;

  let level: 'active' | 'moderate' | 'listening';
  if (percentage >= 15) {
    level = 'active';
  } else if (percentage >= 5) {
    level = 'moderate';
  } else {
    level = 'listening';
  }

  // Determine topics user engaged with
  const topicsEngaged: string[] = [];
  const topicsSkipped: string[] = [];

  for (const theme of themes) {
    const userInTheme = theme.contributors.some((c) =>
      isUser(c, ctx),
    );
    if (userInTheme) {
      topicsEngaged.push(theme.name);
    } else {
      topicsSkipped.push(theme.name);
    }
  }

  // Find missed opportunities: themes matching focus areas where user was absent
  const missedOpportunities: string[] = [];
  for (const theme of themes) {
    if (theme.contributors.some((c) => isUser(c, ctx))) continue;
    // Check if theme keywords overlap with focus areas
    const themeLower = theme.name.toLowerCase() + ' ' + theme.summary.toLowerCase();
    const matches = containsKeywords(themeLower, ctx.focusAreas);
    if (matches.length > 0) {
      missedOpportunities.push(
        `"${theme.name}" — relevant to your work in ${matches.join(', ')}`,
      );
    }
  }

  return {
    messageCount: userCount,
    percentage: Math.round(percentage * 10) / 10,
    level,
    topicsEngaged,
    topicsSkipped,
    missedOpportunities,
  };
}

// ---------------------------------------------------------------------------
// Live Thread Detection
// ---------------------------------------------------------------------------

function detectLiveThreads(
  messages: ParsedMessage[],
  ctx: UserContext,
): LiveThread[] {
  const now = new Date();
  const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // If the latest message is older than 48h, use a relative window
  // from the last message (useful for historical analysis)
  const sorted = [...messages]
    .filter((m) => !m.isSystem)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (sorted.length === 0) return [];

  const latestTimestamp = sorted[0].timestamp;
  const effectiveCutoff =
    latestTimestamp.getTime() > cutoff48h.getTime()
      ? cutoff48h
      : new Date(latestTimestamp.getTime() - 48 * 60 * 60 * 1000);

  const recentMessages = sorted.filter(
    (m) => m.timestamp.getTime() >= effectiveCutoff.getTime(),
  );

  if (recentMessages.length === 0) return [];

  // Cluster recent messages into threads
  const clusters = clusterByTime(recentMessages, 30);
  const liveThreads: LiveThread[] = [];

  for (const cluster of clusters) {
    if (cluster.length < 3) continue;

    const participants = [...new Set(cluster.map((m) => m.author))];
    if (participants.length < 2) continue;

    const userParticipated = cluster.some((m) => isUser(m.author, ctx));

    // Determine topic
    const clusterText = cluster.map((m) => m.body).join(' ');
    const focusMatches = containsKeywords(clusterText, ctx.focusAreas);

    // Determine status
    const lastMsg = cluster[cluster.length - 1];
    const isQuestion = /\?/.test(lastMsg.body);
    const status = isQuestion
      ? `Open question from ${lastMsg.author}`
      : `Last message from ${lastMsg.author} — conversation may still be active`;

    // Only flag threads where user hasn't participated and has relevant expertise
    if (!userParticipated && (focusMatches.length > 0 || cluster.length >= 5)) {
      // Build a topic label from the cluster
      const words = tokenize(clusterText);
      const freq = new Map<string, number>();
      for (const w of words) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
      const topWords = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => capitalize(w));

      const topic = topWords.join(', ');
      const angle =
        focusMatches.length > 0
          ? `Your expertise in ${focusMatches.join(', ')} is directly relevant here.`
          : `Active thread with ${participants.length} participants — consider joining.`;

      // Draft a suggested response
      const keyPoint = cluster
        .filter((m) => m.body.length > 30)
        .sort((a, b) => b.body.length - a.body.length)[0];
      const suggestedMessage = keyPoint
        ? `Building on what ${keyPoint.author} said — from my experience with ${focusMatches[0] ?? ctx.focusAreas[0]}, [your perspective here].`
        : `Interesting thread — I have some experience with ${focusMatches[0] ?? ctx.focusAreas[0]} that might be relevant here.`;

      liveThreads.push({
        topic,
        status,
        participants,
        userAngle: angle,
        suggestedMessage,
      });
    }
  }

  return liveThreads.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Quote Extraction
// ---------------------------------------------------------------------------

function extractNotableQuotes(
  messages: ParsedMessage[],
): { quote: string; author: string }[] {
  const contentMessages = messages.filter(
    (m) => !m.isMedia && !m.isSystem && m.body.length > 40,
  );

  if (contentMessages.length === 0) return [];

  const avgLength =
    contentMessages.reduce((sum, m) => sum + m.body.length, 0) /
    contentMessages.length;

  // Score messages for "quotability"
  const scored = contentMessages.map((msg) => {
    let score = 0;

    // Length: moderately long but not walls of text
    if (msg.body.length > avgLength && msg.body.length < avgLength * 4) {
      score += 2;
    }

    // Original thought indicators
    const thoughtPatterns = [
      /\bi (think|believe|argue|contend)\b/i,
      /\bthe (real|key|core|fundamental)\b/i,
      /\bwe'?re (seeing|witnessing|entering)\b/i,
      /\bthe future\b/i,
      /\bthe question is\b/i,
      /\bwhat if\b/i,
      /\bhere'?s the thing\b/i,
      /\bthe takeaway\b/i,
      /\bmy (bet|prediction|take)\b/i,
      /\bthe irony\b/i,
      /\bthe paradox\b/i,
      /\bpeople (don'?t|forget|overlook|underestimate)\b/i,
    ];
    for (const p of thoughtPatterns) {
      if (p.test(msg.body)) score += 2;
    }

    // Not a reaction or short reply
    if (/^(lol|haha|yes|no|agreed|exactly|right|true|same|100%|this)/i.test(msg.body)) {
      score -= 5;
    }

    // Doesn't start with a question
    if (/^\s*(what|how|when|where|why|who|is|are|do|does|can|could|would)\b/i.test(msg.body)) {
      score -= 1;
    }

    return { msg, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map(({ msg }) => {
    const quote =
      msg.body.length > 280 ? msg.body.slice(0, 280) + '...' : msg.body;
    return { quote, author: msg.author };
  });
}

// ---------------------------------------------------------------------------
// Main Analysis Function
// ---------------------------------------------------------------------------

export function analyzeChat(
  messages: ParsedMessage[],
  userContext: UserContext,
  groupName: string,
): ChatAnalysis {
  // Filter out system messages for most analysis
  const nonSystemMessages = messages.filter((m) => !m.isSystem);

  if (nonSystemMessages.length === 0) {
    return {
      groupName,
      dateRange: { start: new Date(), end: new Date() },
      participantCount: 0,
      messageVolume: 0,
      themes: [],
      bigIdeas: [],
      opportunities: [],
      participation: {
        messageCount: 0,
        percentage: 0,
        level: 'listening',
        topicsEngaged: [],
        topicsSkipped: [],
        missedOpportunities: [],
      },
      liveThreads: [],
      notableQuotes: [],
    };
  }

  // Sort by timestamp
  const sorted = [...nonSystemMessages].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  // Basic stats
  const start = sorted[0].timestamp;
  const end = sorted[sorted.length - 1].timestamp;
  const participants = new Set(sorted.map((m) => m.author));

  // Build term frequency for theme extraction
  const docFreq = termFrequency(sorted);
  const topTerms = significantTerms(
    docFreq,
    sorted.length,
    Math.max(2, Math.floor(sorted.length * 0.02)),
    0.6,
  );

  // Run all analysis passes
  const themes = extractThemes(sorted, topTerms);
  const bigIdeas = detectBigIdeas(sorted, userContext);
  const opportunities = detectOpportunities(sorted, userContext, groupName);
  const participation = analyzeParticipation(sorted, userContext, themes);
  const liveThreads = detectLiveThreads(sorted, userContext);
  const notableQuotes = extractNotableQuotes(sorted);

  return {
    groupName,
    dateRange: { start, end },
    participantCount: participants.size,
    messageVolume: sorted.length,
    themes,
    bigIdeas,
    opportunities,
    participation,
    liveThreads,
    notableQuotes,
  };
}

// ---------------------------------------------------------------------------
// Cross-Group Synthesis
// ---------------------------------------------------------------------------

export function crossGroupSynthesis(
  analyses: ChatAnalysis[],
): CrossGroupSynthesis {
  if (analyses.length < 2) {
    return {
      groupCount: analyses.length,
      groupNames: analyses.map((a) => a.groupName),
      amplifiedSignals: [],
      networkNodes: [],
      compoundingOpportunities: [],
      divergentPerspectives: [],
    };
  }

  const groupNames = analyses.map((a) => a.groupName);

  // 1. Amplified Signals — themes appearing in 2+ groups
  const themeIndex = new Map<string, { groups: string[]; theme: Theme }[]>();
  for (const analysis of analyses) {
    for (const theme of analysis.themes) {
      const key = theme.name.toLowerCase();
      // Also try to match by keyword overlap
      const existing = [...themeIndex.entries()].find(([existingKey]) => {
        const words1 = existingKey.split(/\s+/);
        const words2 = key.split(/\s+/);
        return words1.some((w) => words2.includes(w) && w.length > 3);
      });

      if (existing) {
        existing[1].push({ groups: [analysis.groupName], theme });
      } else {
        themeIndex.set(key, [{ groups: [analysis.groupName], theme }]);
      }
    }
  }

  const amplifiedSignals: CrossGroupSynthesis['amplifiedSignals'] = [];
  for (const [, entries] of themeIndex) {
    const allGroups = [...new Set(entries.flatMap((e) => e.groups))];
    if (allGroups.length >= 2) {
      amplifiedSignals.push({
        theme: entries[0].theme.name,
        groups: allGroups,
        significance: `This topic is being discussed across ${allGroups.length} groups, suggesting it's a broader trend worth tracking. Recurrence levels: ${entries.map((e) => `${e.groups[0]}: ${e.theme.recurrence}`).join(', ')}.`,
      });
    }
  }

  // 2. Network Nodes — people appearing in multiple groups
  const personGroups = new Map<string, Set<string>>();
  for (const analysis of analyses) {
    for (const theme of analysis.themes) {
      for (const contributor of theme.contributors) {
        const groups = personGroups.get(contributor) ?? new Set();
        groups.add(analysis.groupName);
        personGroups.set(contributor, groups);
      }
    }
    // Also check big idea authors
    for (const idea of analysis.bigIdeas) {
      const groups = personGroups.get(idea.author) ?? new Set();
      groups.add(analysis.groupName);
      personGroups.set(idea.author, groups);
    }
  }

  const networkNodes: CrossGroupSynthesis['networkNodes'] = [];
  for (const [person, groups] of personGroups) {
    if (groups.size >= 2) {
      networkNodes.push({
        person,
        groups: [...groups],
        role: `Active in ${groups.size} groups — potential key connector in your network.`,
      });
    }
  }
  networkNodes.sort((a, b) => b.groups.length - a.groups.length);

  // 3. Compounding Opportunities
  const allOpportunities = analyses.flatMap((a) =>
    a.opportunities.map((o) => ({ ...o, analysisGroup: a.groupName })),
  );

  const compoundingOpportunities: CrossGroupSynthesis['compoundingOpportunities'] =
    [];

  // Group opportunities by type, then check for overlap in description keywords
  const oppByType = new Map<string, typeof allOpportunities>();
  for (const opp of allOpportunities) {
    const list = oppByType.get(opp.type) ?? [];
    list.push(opp);
    oppByType.set(opp.type, list);
  }

  for (const [type, opps] of oppByType) {
    if (opps.length < 2) continue;
    // Check if opportunities from different groups
    const groups = new Set(opps.map((o) => o.analysisGroup));
    if (groups.size >= 2) {
      compoundingOpportunities.push({
        opportunity: `Multiple ${type} opportunities across groups`,
        contexts: opps.slice(0, 3).map((o) => ({
          group: o.analysisGroup,
          detail: o.description.slice(0, 150),
        })),
        biggerPlay: `The same type of opportunity (${type}) is surfacing in ${groups.size} different groups. This suggests a systemic trend you could capitalize on.`,
      });
    }
  }

  // 4. Divergent Perspectives — same theme, different takes
  const divergentPerspectives: CrossGroupSynthesis['divergentPerspectives'] = [];
  for (const signal of amplifiedSignals) {
    if (signal.groups.length >= 2) {
      const perspectives: { group: string; stance: string }[] = [];
      for (const groupName of signal.groups) {
        const analysis = analyses.find((a) => a.groupName === groupName);
        if (!analysis) continue;
        const theme = analysis.themes.find(
          (t) =>
            t.name.toLowerCase().includes(signal.theme.toLowerCase()) ||
            signal.theme.toLowerCase().includes(t.name.toLowerCase()),
        );
        if (theme) {
          perspectives.push({
            group: groupName,
            stance: theme.summary.slice(0, 200),
          });
        }
      }
      if (perspectives.length >= 2) {
        divergentPerspectives.push({
          topic: signal.theme,
          perspectives,
        });
      }
    }
  }

  return {
    groupCount: analyses.length,
    groupNames,
    amplifiedSignals,
    networkNodes: networkNodes.slice(0, 10),
    compoundingOpportunities,
    divergentPerspectives,
  };
}
