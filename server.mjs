import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const normalize = (s='') => s.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();

function addViolation(out, code, severity, match, explanation) {
  out.push({ code, severity, match, explanation });
}

function validateLyric({ premise, lyric, forbidden_claims = [], required_claims = [] }) {
  const p = normalize(premise);
  const l = normalize(lyric);
  const violations = [];

  const tests = [
    {
      code: 'UNSUPPORTED_CURRENT_CERTAINTY',
      re: /\b(i know|you still|you always|you never|you would|you'd)\b[^\n.!?]{0,80}\b(now|today|these days|anymore|still)\b/g,
      explanation: 'Potential present-tense certainty or continuity not established by the premise.'
    },
    {
      code: 'OVERBROAD_UNKNOWN_SCOPE',
      re: /\b(there'?s so much i don'?t know|so much about your life|so little (?:i know|about)|i don'?t know you now|i know nothing|everything i know is from then|the things i know are all from then)\b/g,
      explanation: 'Broadens a limited present-day unknown into global ignorance.'
    },
    {
      code: 'INVENTED_COMMUNICATION_STATE',
      re: /\b(i never hear|i don'?t hear|you never tell|we never talk|we don'?t talk|i haven'?t heard)\b/g,
      explanation: 'Adds an unsupported claim about communication frequency or contact.'
    },
    {
      code: 'INVENTED_DESIRE_OR_DECISION',
      re: /\b(i don'?t need to know|i won'?t ask|i won'?t call|i don'?t care|i don'?t want to know|i chose not to|i decided not to)\b/g,
      explanation: 'Adds a desire, decision, indifference, or future intention not entailed by the premise.'
    },
    {
      code: 'UNSUPPORTED_COMPATIBILITY_CLAIM',
      re: /\b(still fits you|doesn'?t fit you|you'?d still choose|you wouldn'?t choose|you'?d never order|you would never order|you wouldn'?t order)\b/g,
      explanation: 'Turns a remembered past fact into a present/hypothetical compatibility claim.'
    },
    {
      code: 'TEMPORAL_QUALIFIER_ADDED',
      re: /\b(always liked|always sat|always ordered|tonight you|today you|these days you)\b/g,
      explanation: 'Adds a temporal/frequency qualifier not guaranteed by the premise.'
    },
    {
      code: 'CRUTCH_LANGUAGE',
      re: /\b(funny how|strange how|somehow|these days|little things|by heart|without even trying|without even thinking|somewhere between)\b/g,
      explanation: 'Matches a DAML originality/crutch-language guard.'
    }
  ];

  for (const t of tests) {
    const matches = [...l.matchAll(t.re)];
    for (const m of matches) addViolation(violations, t.code, 'error', m[0], t.explanation);
  }

  // Premise-sensitive guards for the known semantic class:
  if (/never ordered/.test(p)) {
    for (const re of [/\bwhat you(?:'d| would| wouldn'?t) order\b/g, /\bthings you(?:'d| would| wouldn'?t) order\b/g]) {
      for (const m of l.matchAll(re)) addViolation(
        violations,
        'PAST_FACT_MODAL_DRIFT',
        'error',
        m[0],
        'Premise states a past observed fact ("never ordered"); lyric shifts it into hypothetical/dispositional modality.'
      );
    }
  }

  if (/does not want him back|not about wanting him back|is not about wanting him back/.test(p)) {
    // This premise permits "I don't want you back" but not broader indifference.
    for (const m of l.matchAll(/\b(i don'?t need to know|i don'?t care(?: anymore)?|nothing about you matters)\b/g)) {
      addViolation(violations, 'NO_REUNION_NOT_INDIFFERENCE', 'error', m[0],
        'No desire to reunite does not entail indifference or lack of curiosity.');
    }
  }

  if (/important things about (?:his|your) life now/.test(p) || /present distance/.test(p)) {
    for (const m of l.matchAll(/\b(there'?s so much about your life|so little about your life|i don'?t know your life|not the life you'?re in)\b/g)) {
      addViolation(violations, 'PARTIAL_TO_TOTAL_UNKNOWN_DRIFT', 'error', m[0],
        'Premise supports unknown important current facts, not total or sweeping ignorance of the present life.');
    }
  }

  for (const phrase of forbidden_claims) {
    const n = normalize(phrase);
    if (n && l.includes(n)) addViolation(violations, 'EXPLICIT_FORBIDDEN_CLAIM', 'error', phrase, 'Matches an explicit forbidden claim.');
  }

  const missingRequired = [];
  for (const claim of required_claims) {
    const n = normalize(claim);
    if (n && !l.includes(n)) missingRequired.push(claim);
  }
  for (const claim of missingRequired) {
    addViolation(violations, 'MISSING_REQUIRED_CLAIM', 'error', claim, 'Required claim was not found verbatim.');
  }

  const unique = [];
  const seen = new Set();
  for (const v of violations) {
    const k = v.code + '|' + v.match.toLowerCase();
    if (!seen.has(k)) { seen.add(k); unique.push(v); }
  }

  return {
    pass: unique.length === 0,
    violation_count: unique.length,
    violations: unique,
    validator_version: '1.0.0'
  };
}


function buildServer() {
  const server = new McpServer({ name: 'daml-validator', version: '1.1.0' });

  server.registerTool(
    'validate_lyric',
    {
      title: 'Validate DAML lyric',
      description: 'Fail-closed validation for unsupported lyric claims, temporal drift, scope broadening, modal drift, and DAML crutch language.',
      inputSchema: {
        premise: z.string().min(1),
        lyric: z.string().min(1),
        forbidden_claims: z.array(z.string()).default([]),
        required_claims: z.array(z.string()).default([])
      },
      outputSchema: {
        pass: z.boolean(),
        violation_count: z.number(),
        violations: z.array(z.object({
          code: z.string(),
          severity: z.string(),
          match: z.string(),
          explanation: z.string()
        })),
        validator_version: z.string()
      }
    },
    async (args) => {
      const result = validateLyric(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      };
    }
  );

  server.registerTool(
    'health',
    {
      description: 'Return validator service health.',
      inputSchema: {}
    },
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, service: 'daml-validator', version: '1.1.0' })
      }]
    })
  );

  return server;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'daml-validator', version: '1.1.0' });
});

const mcpServer = buildServer();

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on('close', () => {
    transport.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP_REQUEST_FAIL', error?.stack || error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method Not Allowed' },
    id: null
  });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method Not Allowed' },
    id: null
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log('DAML validator v1.1.0 listening on port ' + port);
});
