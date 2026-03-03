// services/openai.service.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET_USD) || 2.00;

// API key guard
if (!OPENAI_API_KEY) {
  console.warn('[OpenAI] ⚠️ API key missing — AI features will be disabled');
}

// Simple in-memory usage tracker
let usage = {
  totalTokens: 0,
  totalCostUSD: 0,
  month: new Date().getMonth(),
  year: new Date().getFullYear()
};

function checkBudget() {
  const now = new Date();
  if (usage.month !== now.getMonth() || usage.year !== now.getFullYear()) {
    usage = { totalTokens: 0, totalCostUSD: 0, month: now.getMonth(), year: now.getFullYear() };
  }
  return usage.totalCostUSD < MONTHLY_BUDGET;
}

function trackUsage(tokens, cost) {
  usage.totalTokens += tokens;
  usage.totalCostUSD += cost;
  console.log(`[OpenAI] This month: $${usage.totalCostUSD.toFixed(4)} / $${MONTHLY_BUDGET}`);
}

/**
 * Tight trigger rules - only for deep reasoning
 */
export function needsOpenAI(message, lowerMessage) {
  const aiOnlyPatterns = [
    'strategy to',
    'how can i improve',
    'what should i do to',
    'plan to',
    'advice on',
    'tips for',
    'recommend a',
    'suggest a',
    'help me prepare',
    'struggling with',
    'motivation',
    'overwhelmed',
    'study technique',
    'learning style',
    'time management',
    'feeling stressed',
    'feeling overwhelmed',
    'feeling anxious',
    'feeling demotivated'
  ];
  
  return aiOnlyPatterns.some(pattern => lowerMessage.includes(pattern));
}

/**
 * Check if we have enough data for meaningful AI response
 */
function hasEnoughContext(context) {
  const hasAttendance = context.attendance?.totalHeld > 0;
  const hasGrades = context.cgpa?.length > 0;
  const hasAssignments = context.assignmentCount > 0;
  const hasExpenses = context.expenses?.total > 0;
  
  return hasAttendance || hasGrades || hasAssignments || hasExpenses;
}

/**
 * Call OpenAI Responses API
 */
export async function callOpenAI(message, context = {}) {
  try {
    if (!OPENAI_API_KEY) return null;

    if (!checkBudget()) {
      console.log('[OpenAI] Monthly budget exceeded');
      return null;
    }

    if (!hasEnoughContext(context)) {
      return "I'd love to help with that, but I don't have enough data about you yet. Try adding some attendance, grades, or assignments first.";
    }

    const systemPrompt = `You are Aisha's personal academic assistant — calm, warm, and quietly brilliant.

Personality:
- Speak like a friendly senior who's been through it all
- Never robotic — use natural pauses, occasional warmth
- Never use bullet points or markdown
- Keep responses to 2-3 sentences unless asked for detail
- If data is missing, gently suggest adding it
- Never say "as an AI" or "I don't have access"
- You HAVE access to their data — use it
- Avoid repeating the student's name in every response
- Use their name only occasionally, naturally`;

    // Build context naturally
    const contextLines = [];
    if (context.attendance?.totalHeld > 0) {
      contextLines.push(`- Attendance: ${context.attendance.percentage}% (${context.attendance.totalAttended}/${context.attendance.totalHeld})`);
      
      if (context.attendance.subjects) {
        const lowSubjects = Object.entries(context.attendance.subjects)
          .filter(([_, data]) => data.percentage < 75)
          .map(([name]) => name);
        if (lowSubjects.length > 0) {
          contextLines.push(`- Low attendance in: ${lowSubjects.join(', ')}`);
        }
      }
    }
    
    if (context.cgpa?.length > 0) {
      const latest = context.cgpa[context.cgpa.length - 1];
      const sgpa = latest.sgpa || latest.gpa || latest.score;
      contextLines.push(`- Current SGPA: ${sgpa.toFixed(2)} (${context.cgpa.length} semesters)`);
    }
    
    if (context.assignmentCount > 0) {
      contextLines.push(`- Pending assignments: ${context.assignmentCount}`);
    }
    
    if (context.expenses?.thisMonth > 0) {
      contextLines.push(`- Spent this month: ₹${context.expenses.thisMonth}`);
    }

    const userPrompt = `
Student data:
${contextLines.join('\n')}

Question: "${message}"

Respond naturally as their calm, helpful assistant.`;

    const response = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: OPENAI_MODEL,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_output_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Safer response parsing
    const text =
      response.data.output_text ||
      response.data.output?.[0]?.content?.[0]?.text ||
      '';
    
    if (!text.trim()) return null;

    // Track usage
    const totalTokens = response.data.usage?.total_tokens || 0;
    const estimatedCost = (totalTokens / 1_000_000) * 0.30;
    trackUsage(totalTokens, estimatedCost);

    return text;

  } catch (error) {
    console.error('[OpenAI Error]:', error.response?.data || error.message);
    return null;
  }
}