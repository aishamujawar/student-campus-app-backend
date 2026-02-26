import express from 'express';
import { body, validationResult } from 'express-validator';

const router = express.Router();
const DEBUG = process.env.NODE_ENV !== 'production';

/**
 * Campus Assistant - Calm academic advisor tone
 * Personal, name-aware responses with natural flow
 */

// Helper functions
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const getDayName = index => DAYS[index] ?? `Day ${index + 1}`;

// Professional reply formatting
function formatReply(lines) {
  return lines.filter(Boolean).join('\n');
}

// Paragraph builder for natural flow
function paragraph(lines) {
  return lines.filter(Boolean).join(' ');
}

// Probabilistic name usage (35% chance for responses, 50% for greetings)
function addressMaybe(text, userName) {
  const useName = Math.random() < 0.35;
  if (!useName || !userName) return text;
  return `${userName}, ${text}`;
}

// Enhanced date filtering with validation
function getFutureDates(items) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return items
    .filter(item => {
      if (!item?.date) return false;
      const d = new Date(item.date);
      if (isNaN(d.getTime())) return false;
      return d >= today;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Input validation middleware
const validateChat = [
  body('message')
    .exists().withMessage('Message is required')
    .isString().withMessage('Message must be text')
    .trim()
    .isLength({ min: 1, max: 500 }).withMessage('Message must be 1–500 characters')
    .customSanitizer(value => 
      typeof value === 'string' ? value.replace(/[<>]/g, '') : value
    ), // Remove angle brackets for basic XSS protection with type guard
  
  body('user.firstName')
    .optional()
    .isString().withMessage('First name must be text')
    .trim()
    .isLength({ max: 50 }).withMessage('First name too long'),
  
  body('assignments')
    .optional()
    .isObject().withMessage('Assignments must be an object'),
  
  body('timetable')
    .optional()
    .isObject().withMessage('Timetable must be an object'),
  
  body('todayIndex')
    .optional()
    .isInt({ min: 0, max: 6 }).withMessage('Today index must be between 0-6'),
  
  body('cgpa')
    .optional()
    .isArray().withMessage('CGPA must be an array'),
  
  body('calendarMarks')
    .optional()
    .isArray().withMessage('Calendar marks must be an array'),
  
  body('attendance')
    .optional()
    .isObject().withMessage('Attendance must be an object'),
  
  body('attendance.totalHeld')
    .optional()
    .isInt({ min: 0 }).withMessage('Total held must be a positive number'),
  
  body('attendance.totalAttended')
    .optional()
    .isInt({ min: 0 }).withMessage('Total attended must be a positive number'),
  
  body('attendance.percentage')
    .optional()
    .isFloat({ min: 0, max: 100 }).withMessage('Percentage must be between 0-100'),
  
  body('expenses')
    .optional()
    .isObject().withMessage('Expenses must be an object'),
  
  body('expenses.thisMonth')
    .optional()
    .isFloat({ min: 0 }).withMessage('Monthly expense must be a positive number'),
  
  body('expenses.total')
    .optional()
    .isFloat({ min: 0 }).withMessage('Total expense must be a positive number')
];

router.post('/chat', validateChat, async (req, res) => {
  try {
    // Defense in depth: Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // SECURITY LOGGING: Log validation failures
      console.warn('[SECURITY] Validation failed:', {
        ip: req.ip,
        path: req.originalUrl,
        errors: errors.array(),
        timestamp: new Date().toISOString()
      });
      
      return res.status(400).json({
        intent: 'VALIDATION_ERROR',
        reply: 'I received some invalid information. Please check your request format.',
        errors: DEBUG ? errors.array() : undefined
      });
    }

    // Extra defense: Type check message again (defense in depth)
    if (typeof req.body.message !== 'string') {
      // SECURITY LOGGING: Log type mismatch
      console.warn('[SECURITY] Type validation failed:', {
        ip: req.ip,
        path: req.originalUrl,
        expected: 'string',
        received: typeof req.body.message,
        timestamp: new Date().toISOString()
      });
      
      return res.status(400).json({
        intent: 'VALIDATION_ERROR',
        reply: 'Invalid message format.'
      });
    }

    const { 
      message, 
      user = { firstName: 'there' },
      assignments = {}, 
      timetable = {}, 
      todayIndex = 0,
      cgpa = [], 
      calendarMarks = [],
      attendance = {},
      expenses = {}
    } = req.body;

    // Message sanitization - validator already trimmed once
    let sanitizedMessage = message;
    
    // Basic XSS prevention - remove script tags and dangerous content
    sanitizedMessage = sanitizedMessage.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    sanitizedMessage = sanitizedMessage.replace(/javascript:/gi, '');
    // Safer attribute removal with leading space check
    sanitizedMessage = sanitizedMessage.replace(/\son\w+=/gi, '');
    
    // Limit message length again as safety
    if (sanitizedMessage.length > 500) {
      sanitizedMessage = sanitizedMessage.substring(0, 500);
    }

    // Get user name
    const userName = user.firstName || 'there';

    // Defensive conversion for lowerMessage
    const lowerMessage = String(sanitizedMessage).toLowerCase();

    // Development logging only
    if (DEBUG) {
      console.log('[Assistant] Received query:', {
        userName,
        message: sanitizedMessage.substring(0, 50),
        expensesThisMonth: expenses.thisMonth || 0,
        calendarMarksCount: calendarMarks.length,
        hasSubjectsAttendance: attendance.subjects ? Object.keys(attendance.subjects).length : 0
      });
    }

    let reply = '';
    let intent = 'GENERAL_QUERY';
    
    // Single now reference for all date calculations
    const now = new Date();
    
    // Calculate day index (Monday=0)
    const jsTodayIndex = now.getDay();
    const normalizedTodayIndex = jsTodayIndex === 0 ? 6 : jsTodayIndex - 1;
    
    // Calculate assignment count safely (handle non-numbers)
    const assignmentCount = Object.values(assignments)
      .reduce((sum, count) => sum + (Number(count) || 0), 0);
    
    // Normalize class times
    const normalizeClassTime = (cls) => {
      if (cls.startTime && cls.endTime) return cls;
      
      if (cls.time && cls.time.includes('-')) {
        const [start, end] = cls.time.split('-').map(t => t.trim());
        return { ...cls, startTime: start, endTime: end };
      }
      
      return cls;
    };
    
    // Get classes for a specific day
    const getClassesForDay = (dayIndex) => {
      const classes = timetable[`day_${dayIndex}`] || [];
      return classes.map(normalizeClassTime);
    };
    
    // Analyze weekly pattern
    const analyzeWeeklyPattern = () => {
      const analysis = {
        busiestDay: { day: null, count: 0 },
        lightestDay: { day: null, count: Infinity },
        totalClasses: 0,
        daysWithClasses: 0
      };
      
      for (let i = 0; i < 7; i++) {
        const classes = getClassesForDay(i);
        const count = classes.length;
        
        analysis.totalClasses += count;
        if (count > 0) analysis.daysWithClasses++;
        
        if (count > analysis.busiestDay.count) {
          analysis.busiestDay = { day: i, count };
        }
        
        if (count < analysis.lightestDay.count && count > 0) {
          analysis.lightestDay = { day: i, count };
        }
      }
      
      if (analysis.lightestDay.count === Infinity) {
        analysis.lightestDay = { day: null, count: 0 };
      }
      
      return analysis;
    };

    // 👤 NAME QUERY
    if (
      lowerMessage.includes('what is my name') ||
      lowerMessage.includes('who am i') ||
      lowerMessage.includes('do you know my name') ||
      lowerMessage.includes('what\'s my name') ||
      lowerMessage.includes('whats my name')
    ) {
      intent = 'NAME_QUERY';
      reply = `Your name is ${userName}. How can I help you today?`;
    }

    // 🎯 MONTHLY EXPENSE QUERY
    else if (
      lowerMessage.includes('this month') &&
      (lowerMessage.includes('spend') || lowerMessage.includes('expense'))
    ) {
      intent = 'EXPENSE_MONTHLY';

      if (!expenses || typeof expenses.thisMonth !== 'number') {
        reply = addressMaybe("I don't have any expense records for this month yet.", userName);
      } else {
        const spending = expenses.thisMonth.toFixed(2);
        
        if (expenses.thisMonth > 10000) {
          reply = paragraph([
            `You've spent ₹${spending} this month, which is on the higher side.`,
            "Might be worth reviewing where the money's going — especially discretionary spending."
          ]);
        } else if (expenses.thisMonth > 5000) {
          reply = paragraph([
            `So far this month, you've spent ₹${spending}.`,
            "That's within a moderate range — nothing alarming."
          ]);
        } else {
          reply = paragraph([
            `Your spending this month is at ₹${spending}.`,
            "Looks like you're keeping things under control."
          ]);
        }
      }
    }

    // 💰 EXPENSE INSIGHTS
    else if (
      lowerMessage.includes('expense') ||
      lowerMessage.includes('spend') ||
      lowerMessage.includes('spent') ||
      lowerMessage.includes('money') ||
      lowerMessage.includes('budget') ||
      lowerMessage.includes('cost') ||
      lowerMessage.includes('expensive') ||
      lowerMessage.includes('saving')
    ) {
      intent = 'EXPENSE_INSIGHTS';

      if (!expenses || Object.keys(expenses).length === 0) {
        reply = addressMaybe("I don't have any expense records yet. Start tracking your spending and I can help you manage your budget.", userName);
      } else {
        const total = expenses.total || 0;
        const thisMonth = expenses.thisMonth || 0;
        const categories = expenses.categories || {};

        const parts = [
          `Overall, you've spent ₹${total.toFixed(2)} across all time, with ₹${thisMonth.toFixed(2)} so far this month.`
        ];

        if (thisMonth > 10000) {
          parts.push("This month's spending is a bit elevated — worth keeping an eye on.");
        } else if (thisMonth > 5000) {
          parts.push("Monthly spending is within a reasonable range.");
        } else if (thisMonth > 0) {
          parts.push("You're spending at a comfortable pace right now.");
        }

        if (Object.keys(categories).length > 0) {
          const sortedCategories = Object.entries(categories)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);

          if (sortedCategories.length > 0) {
            parts.push("Your main spending areas:");
            sortedCategories.forEach(([cat, amt]) => {
              const percentage = total > 0 ? ((amt / total) * 100).toFixed(1) : 0;
              parts.push(`• ${cat}: ₹${amt.toFixed(2)} (${percentage}% of total)`);
            });
          }
        }

        reply = addressMaybe(parts.join(' '), userName);
      }
    }

    // 📊 ATTENDANCE INSIGHTS - UPDATED WITH PER-SUBJECT
    else if (
      lowerMessage.includes('attendance') ||
      lowerMessage.includes('present') ||
      lowerMessage.includes('absent') ||
      lowerMessage.includes('percentage')
    ) {
      intent = 'ATTENDANCE_INSIGHTS';

      if (!attendance || attendance.totalHeld === 0) {
        reply = addressMaybe("No attendance records yet. Once classes start, I can help you track it.", userName);
        return res.json({ intent, reply });
      }

      const percentage = attendance.percentage;
      const attended = attendance.totalAttended;
      const held = attendance.totalHeld;

      // Check if asking for per-subject attendance
      if (
        lowerMessage.includes('per subject') ||
        lowerMessage.includes('by subject') ||
        lowerMessage.includes('each subject') ||
        lowerMessage.includes('subject wise') ||
        lowerMessage.includes('subject-wise') ||
        lowerMessage.includes('subject breakdown') ||
        lowerMessage.includes('breakdown by subject')
      ) {
        // PER-SUBJECT ATTENDANCE RESPONSE
        const subjects = attendance.subjects || {};
        const subjectEntries = Object.entries(subjects);
        
        if (subjectEntries.length === 0) {
          reply = addressMaybe("No subject-wise attendance data available.", userName);
        } else {
          const lines = ["Here's your attendance by subject:"];
          
          // Sort by percentage (lowest first) to highlight concerning subjects
          const sortedSubjects = subjectEntries.sort((a, b) => {
            const percentA = a[1].percentage || 0;
            const percentB = b[1].percentage || 0;
            return percentA - percentB;
          });
          
          sortedSubjects.forEach(([subjectName, data]) => {
            const subPercent = data.percentage || 0;
            const subAttended = data.attended || 0;
            const subHeld = data.held || 0;
            
            let indicator = '';
            if (subPercent < 75) indicator = '⚠️';
            else if (subPercent >= 85) indicator = '✓';
            
            lines.push(`${indicator} ${subjectName}: ${subPercent}% (${subAttended}/${subHeld})`);
          });
          
          // Add summary
          lines.push(`\nOverall: ${percentage}% (${attended}/${held})`);
          
          reply = formatReply(lines);
        }
      } 
      else if (
        lowerMessage.includes('which subject') ||
        lowerMessage.includes('what subject') ||
        /subject.*low|low.*subject/.test(lowerMessage) ||
        /subject.*below|below.*subject/.test(lowerMessage)
      ) {
        // FIND LOWEST ATTENDANCE SUBJECT
        const subjects = attendance.subjects || {};
        const subjectEntries = Object.entries(subjects);
        
        if (subjectEntries.length === 0) {
          reply = addressMaybe("No subject-wise data available.", userName);
        } else {
          // Find subject with lowest percentage
          let lowestSubject = null;
          let lowestPercent = 101;
          
          subjectEntries.forEach(([name, data]) => {
            const percent = data.percentage || 0;
            if (percent < lowestPercent && data.held > 0) {
              lowestPercent = percent;
              lowestSubject = name;
            }
          });
          
          if (lowestSubject && lowestPercent < 75) {
            const data = subjects[lowestSubject];
            // Prevent negative needed values
            const needed = Math.max(0, Math.ceil(data.held * 0.75) - data.attended);
            reply = addressMaybe(
              `Your lowest attendance is in ${lowestSubject} at ${lowestPercent}% (${data.attended}/${data.held}). You need to attend ${needed} more classes to reach 75%.`,
              userName
            );
          } else if (lowestSubject) {
            reply = addressMaybe(
              `Your lowest attendance is in ${lowestSubject} at ${lowestPercent}%, which is still above 75%.`,
              userName
            );
          } else {
            reply = addressMaybe("All your subjects are above 75% attendance.", userName);
          }
        }
      }
      else {
        // OVERALL ATTENDANCE RESPONSE
        const parts = [
          `Your attendance is at ${percentage}% (${attended} out of ${held} classes).`
        ];

        if (percentage < 75) {
          parts.push("This is below the 75% threshold — something to be mindful of.");
          const needed = Math.max(0, Math.ceil(held * 0.75) - attended);
          if (needed > 0) {
            parts.push(`You'd need to attend ${needed} more classes to reach 75%.`);
          }
          
          // Add note about subject breakdown if available
          if (attendance.subjects && Object.keys(attendance.subjects).length > 0) {
            parts.push("Want to see the breakdown by subject? Just ask.");
          }
        } else if (percentage < 85) {
          parts.push("It's acceptable, though there's room to improve.");
        } else {
          parts.push("You're maintaining good attendance — that's solid.");
        }

        reply = addressMaybe(parts.join(' '), userName);
      }
    }

    // 🎓 ACADEMIC PERFORMANCE - FIXED WITH MORE KEYWORDS
    else if (
      lowerMessage.includes('cgpa') || 
      lowerMessage.includes('gpa') || 
      lowerMessage.includes('grade') ||
      lowerMessage.includes('sgpa') ||
      lowerMessage.includes('semester') ||
      lowerMessage.includes('marks') ||
      lowerMessage.includes('performance') ||
      lowerMessage.includes('result') ||
      lowerMessage.includes('academic') ||
      lowerMessage.includes('progress') ||
      lowerMessage.includes('improvement') ||
      lowerMessage.includes('trend')
    ) {
      intent = 'ACADEMIC_INSIGHTS';
      
      if (cgpa.length === 0) {
        reply = addressMaybe("No academic records yet. Add your semester grades and I can track your progress.", userName);
      } 
      
      // =========================================
      // SHOW ALL GRADES (SEMESTER WISE)
      // =========================================
      else if (
        lowerMessage.includes('all') ||
        lowerMessage.includes('semester wise') ||
        lowerMessage.includes('semester-wise') ||
        lowerMessage.includes('each semester') ||
        lowerMessage.includes('breakdown') ||
        lowerMessage.includes('list') ||
        lowerMessage.includes('show my grades') ||
        lowerMessage.includes('show grades')
      ) {
        const lines = [`You have ${cgpa.length} semester${cgpa.length > 1 ? 's' : ''} of data:`];
        
        // Show each semester with its SGPA
        cgpa.forEach((sem, index) => {
          const sgpa = sem.sgpa || sem.gpa || sem.score;
          const semesterName = sem.semester || sem.name || `Semester ${index + 1}`;
          lines.push(`  ${index + 1}. ${semesterName}: ${sgpa.toFixed(2)}`);
        });
        
        // Calculate CGPA (average of all semesters)
        if (cgpa.length > 1) {
          const total = cgpa.reduce((sum, sem) => {
            const sgpa = sem.sgpa || sem.gpa || sem.score;
            return sum + sgpa;
          }, 0);
          const cgpaAvg = (total / cgpa.length).toFixed(2);
          lines.push(`\nOverall CGPA: ${cgpaAvg}`);
        }
        
        reply = formatReply(lines);
      }
      
      // =========================================
      // TREND ANALYSIS
      // =========================================
      else if (
        lowerMessage.includes('trend') || 
        lowerMessage.includes('progress') ||
        lowerMessage.includes('improvement') ||
        lowerMessage.includes('change')
      ) {
        if (cgpa.length > 1) {
          const first = cgpa[0].sgpa || cgpa[0].gpa || cgpa[0].score;
          const latest = cgpa[cgpa.length - 1];
          const sgpa = latest.sgpa || latest.gpa || latest.score;
          const difference = sgpa - first;
          
          // Show trend with emoji indicator
          let trend = '';
          if (difference > 0.3) trend = '📈 strong improvement';
          else if (difference > 0) trend = '📈 slight improvement';
          else if (difference < -0.3) trend = '📉 significant drop';
          else if (difference < 0) trend = '📉 slight decline';
          else trend = '➡️ stable';
          
          const parts = [
            `Over ${cgpa.length} semesters, your grades have shown ${trend}.`,
            `Started at ${first.toFixed(2)} → now at ${sgpa.toFixed(2)} (${difference > 0 ? '+' : ''}${difference.toFixed(2)}).`
          ];
          
          // Show semester-by-semester progression
          if (cgpa.length <= 4) {
            const progression = cgpa.map((sem, i) => {
              const val = sem.sgpa || sem.gpa || sem.score;
              return val.toFixed(2);
            }).join(' → ');
            parts.push(`Semester progression: ${progression}`);
          }
          
          reply = addressMaybe(parts.join(' '), userName);
        } else {
          reply = addressMaybe(`Your current SGPA is ${(cgpa[0].sgpa || cgpa[0].gpa || cgpa[0].score).toFixed(2)}. Add more semesters to see trends.`, userName);
        }
      }
      
      // =========================================
      // LATEST SGPA ONLY (DEFAULT)
      // =========================================
      else {
        const latest = cgpa[cgpa.length - 1];
        const sgpa = latest.sgpa || latest.gpa || latest.score;
        const semesterName = latest.semester || latest.name || `Semester ${cgpa.length}`;
        
        // If only one semester exists
        if (cgpa.length === 1) {
          reply = addressMaybe(`Your SGPA for ${semesterName} is ${sgpa.toFixed(2)}.`, userName);
        } 
        // Multiple semesters - show latest and offer more options
        else {
          // Calculate CGPA
          const total = cgpa.reduce((sum, sem) => {
            const val = sem.sgpa || sem.gpa || sem.score;
            return sum + val;
          }, 0);
          const cgpaAvg = (total / cgpa.length).toFixed(2);
          
          reply = paragraph([
            addressMaybe(`Your latest SGPA (${semesterName}) is ${sgpa.toFixed(2)}.`, userName),
            `Your overall CGPA across ${cgpa.length} semesters is ${cgpaAvg}.`,
            `Want to see all semesters or grade trends? Just ask.`
          ]);
        }
      }
    }

    // 📝 ASSIGNMENTS & DEADLINES
    else if (
      lowerMessage.includes('assignment') || 
      lowerMessage.includes('homework') || 
      lowerMessage.includes('deadline') ||
      lowerMessage.includes('due') ||
      lowerMessage.includes('project')
    ) {
      intent = 'ASSIGNMENT_PLANNING';
      
      if (assignmentCount === 0) {
        reply = addressMaybe("No pending assignments at the moment.", userName);
        return res.json({ intent, reply });
      }

      const assignmentDates = Object.keys(assignments);
      const sortedDates = assignmentDates.sort();
      
      if (lowerMessage.includes('week') || lowerMessage.includes('this week')) {
        const weekAssignments = sortedDates.filter(date => {
          const daysUntil = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
          return daysUntil >= 0 && daysUntil <= 7;
        });
        
        if (weekAssignments.length > 0) {
          const lines = ["Here's what's due this week:"];
          weekAssignments.forEach(date => {
            const count = assignments[date];
            const daysUntil = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
            lines.push(`• ${date}: ${count} assignment${count > 1 ? 's' : ''} (in ${daysUntil} days)`);
          });
          reply = addressMaybe(lines.join(' '), userName);
        } else {
          reply = addressMaybe("Nothing due this week — a good time to get ahead.", userName);
        }
      }
      
      else if (lowerMessage.includes('next') || lowerMessage.includes('upcoming')) {
        const nextDate = sortedDates[0];
        const nextCount = assignments[nextDate];
        const daysUntil = Math.ceil((new Date(nextDate) - now) / (1000 * 60 * 60 * 24));
        
        reply = addressMaybe(
          `Your next deadline is ${nextDate} — ${nextCount} assignment${nextCount > 1 ? 's' : ''} due in ${daysUntil} days.`,
          userName
        );
      }
      
      else {
        const nearestDate = sortedDates[0];
        const nearestCount = assignments[nearestDate];
        const daysUntil = Math.ceil((new Date(nearestDate) - now) / (1000 * 60 * 60 * 24));
        
        reply = addressMaybe(
          `You have ${assignmentCount} pending assignment${assignmentCount > 1 ? 's' : ''}. The nearest is on ${nearestDate} (${nearestCount} assignment${nearestCount > 1 ? 's' : ''}, ${daysUntil} days).`,
          userName
        );
      }
    }

    // 📅 CALENDAR & EVENTS - CLEAN FORMATTING
    else if (
      lowerMessage.includes('calendar') || 
      lowerMessage.includes('event') || 
      lowerMessage.includes('exam') ||
      lowerMessage.includes('holiday') ||
      lowerMessage.includes('important date') ||
      lowerMessage.includes('meeting')
    ) {
      intent = 'CALENDAR_MANAGEMENT';
      
      if (calendarMarks.length === 0) {
        reply = addressMaybe("Your calendar is clear — no dates marked yet.", userName);
        return res.json({ intent, reply });
      }

      const futureDates = getFutureDates(calendarMarks);
      
      if (lowerMessage.includes('holiday')) {
        const holidays = futureDates.filter(d =>
          (d.categoryName || '').toLowerCase().includes('holiday') ||
          (d.categoryName || '').toLowerCase().includes('break') ||
          (d.categoryName || '').toLowerCase().includes('vacation')
        );

        if (holidays.length === 0) {
          reply = addressMaybe("No upcoming holidays scheduled.", userName);
        } else {
          const nextHoliday = holidays[0];
          const daysUntil = Math.ceil(
            (new Date(nextHoliday.date) - now) / (1000 * 60 * 60 * 24)
          );

          reply = addressMaybe(
            `Your next holiday is on ${nextHoliday.date} — ${daysUntil} day${daysUntil !== 1 ? 's' : ''} to go.`,
            userName
          );
        }
      }
      
      else if (lowerMessage.includes('exam')) {
        const exams = futureDates.filter(d =>
          (d.categoryName || '').toLowerCase().includes('exam') ||
          (d.categoryName || '').toLowerCase().includes('test')
        );

        if (exams.length === 0) {
          reply = addressMaybe("No upcoming exams in your calendar.", userName);
        } else {
          const nextExam = exams[0];
          const daysUntil = Math.ceil(
            (new Date(nextExam.date) - now) / (1000 * 60 * 60 * 24)
          );

          reply = addressMaybe(
            `Your next exam is on ${nextExam.date} — ${daysUntil} day${daysUntil !== 1 ? 's' : ''} left.`,
            userName
          );
        }
      }
      
      else if (lowerMessage.includes('next') || lowerMessage.includes('upcoming')) {
        if (futureDates.length === 0) {
          reply = addressMaybe("No upcoming dates in your calendar.", userName);
        } else {
          const nextDate = futureDates[0];
          const daysUntil = Math.ceil(
            (new Date(nextDate.date) - now) / (1000 * 60 * 60 * 24)
          );
          
          reply = addressMaybe(
            `Your next marked date is ${nextDate.date} (${nextDate.categoryName}) — in ${daysUntil} days.`,
            userName
          );
        }
      }
      
      else {
        if (futureDates.length === 0) {
          reply = addressMaybe("No upcoming dates in your calendar.", userName);
        } else {
          // Show ALL dates with clean bullet points
          const lines = [
            `You have ${futureDates.length} upcoming date${futureDates.length > 1 ? 's' : ''}:`
          ];

          futureDates.forEach((d, i) => {
            const daysUntil = Math.ceil(
              (new Date(d.date) - now) / (1000 * 60 * 60 * 24)
            );
            lines.push(`  ${i+1}. ${d.date} — ${d.categoryName} (in ${daysUntil} days)`);
          });

          reply = formatReply(lines);
        }
      }
    }

    // ⏰ TIMETABLE & SCHEDULE - FIXED INTENT DETECTION
    else if (
      // Class-related queries
      lowerMessage.includes('class') || 
      lowerMessage.includes('lecture') || 
      lowerMessage.includes('timetable') ||
      lowerMessage.includes('schedule') ||
      
      // Day-specific queries
      lowerMessage.includes('tomorrow') ||
      lowerMessage.includes('today') ||
      lowerMessage.includes('monday') ||
      lowerMessage.includes('tuesday') ||
      lowerMessage.includes('wednesday') ||
      lowerMessage.includes('thursday') ||
      lowerMessage.includes('friday') ||
      lowerMessage.includes('saturday') ||
      lowerMessage.includes('sunday') ||
      
      // Free day queries
      lowerMessage.includes('free day') ||
      lowerMessage.includes('off day') ||
      lowerMessage.includes('day off') ||
      
      // Week queries
      lowerMessage.includes('week') ||
      lowerMessage.includes('weekly') ||
      
      // Workload queries - EXPANDED
      lowerMessage.includes('busy') ||
      lowerMessage.includes('packed') ||
      lowerMessage.includes('workload') ||
      lowerMessage.includes('work load') ||
      lowerMessage.includes('how busy') ||
      lowerMessage.includes('how packed') ||
      lowerMessage.includes('am i busy') ||
      lowerMessage.includes('am i too busy') ||
      lowerMessage.includes('am i packed') ||
      lowerMessage.includes('is my week busy') ||
      lowerMessage.includes('is my week packed') ||
      lowerMessage.includes('overall load') ||
      
      // Busiest day queries
      lowerMessage.includes('busiest day') ||
      lowerMessage.includes('most busy') ||
      lowerMessage.includes('which day is busiest') ||
      lowerMessage.includes('what is my busiest day') ||
      lowerMessage.includes('when am i busiest')
    ) {
      intent = 'TIMETABLE_ANALYSIS';
      
      // DEBUG: Log what triggered timetable
      if (DEBUG) {
        console.log('[Timetable] Triggered by:', lowerMessage);
      }
      
      const analysis = analyzeWeeklyPattern();
      const todayClasses = getClassesForDay(normalizedTodayIndex);
      const tomorrowClasses = getClassesForDay((normalizedTodayIndex + 1) % 7);
      
      const dayMap = {
        'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
        'friday': 4, 'saturday': 5, 'sunday': 6
      };

      // Check for specific day mention
      let specificDay = null;
      for (const [day, index] of Object.entries(dayMap)) {
        if (lowerMessage.includes(day)) {
          specificDay = index;
          break;
        }
      }
      
      // =========================================
      // BUSIEST DAY QUERY - MUST COME FIRST
      // =========================================
      if (
        lowerMessage.includes('busiest day') || 
        lowerMessage.includes('most busy') ||
        lowerMessage.includes('which day is busiest') ||
        lowerMessage.includes('what is my busiest day') ||
        lowerMessage.includes('when am i busiest')
      ) {
        if (analysis.busiestDay.day !== null) {
          const dayName = getDayName(analysis.busiestDay.day);
          reply = addressMaybe(
            `Your busiest day is ${dayName} with ${analysis.busiestDay.count} classes.`,
            userName
          );
        } else if (analysis.totalClasses === 0) {
          reply = addressMaybe("No classes scheduled this week.", userName);
        } else {
          reply = addressMaybe("Your schedule is pretty evenly spread out.", userName);
        }
      }
      
      // =========================================
      // WORKLOAD ANALYSIS QUERY
      // =========================================
      else if (
        lowerMessage.includes('busy') || 
        lowerMessage.includes('packed') ||
        lowerMessage.includes('workload') ||
        lowerMessage.includes('work load') ||
        lowerMessage.includes('how busy') ||
        lowerMessage.includes('how packed') ||
        lowerMessage.includes('am i busy') ||
        lowerMessage.includes('am i too busy') ||
        lowerMessage.includes('am i packed') ||
        lowerMessage.includes('is my week busy') ||
        lowerMessage.includes('is my week packed') ||
        lowerMessage.includes('overall load')
      ) {
        if (analysis.totalClasses === 0) {
          reply = addressMaybe("No classes scheduled this week — you're completely free.", userName);
        } else {
          const parts = [
            `You have ${analysis.totalClasses} classes across ${analysis.daysWithClasses} days this week.`
          ];
          
          if (analysis.totalClasses >= 8) {
            parts.push("That's quite a full week — make sure to pace yourself.");
          } else if (analysis.totalClasses >= 5) {
            parts.push("A moderate week — manageable with good planning.");
          } else {
            parts.push("A lighter week — good time to get ahead on other work.");
          }
          
          if (analysis.busiestDay.day !== null) {
            parts.push(`Your busiest day is ${getDayName(analysis.busiestDay.day)} with ${analysis.busiestDay.count} classes.`);
          }
          
          reply = addressMaybe(parts.join(' '), userName);
        }
      }
      
      // =========================================
      // TOMORROW QUERY
      // =========================================
      else if (lowerMessage.includes('tomorrow')) {
        if (tomorrowClasses.length > 0) {
          const classList = tomorrowClasses.map(c => c.name || c.subject || 'class').join(', ');
          reply = addressMaybe(
            `Tomorrow you have ${tomorrowClasses.length} class${tomorrowClasses.length > 1 ? 'es' : ''}: ${classList}.`,
            userName
          );
        } else {
          reply = addressMaybe("No classes tomorrow — you're free.", userName);
        }
      }
      
      // =========================================
      // TODAY QUERY
      // =========================================
      else if (lowerMessage.includes('today')) {
        if (todayClasses.length > 0) {
          const classList = todayClasses.map(c => c.name || c.subject || 'class').join(', ');
          reply = addressMaybe(
            `Today's schedule: ${todayClasses.length} class${todayClasses.length > 1 ? 'es' : ''} — ${classList}.`,
            userName
          );
        } else {
          reply = addressMaybe("No classes today. A good day to catch up on work.", userName);
        }
      }
      
      // =========================================
      // SPECIFIC DAY QUERY
      // =========================================
      else if (specificDay !== null) {
        const classes = getClassesForDay(specificDay);
        if (classes.length > 0) {
          const classList = classes.map(c => c.name || c.subject || 'class').join(', ');
          reply = addressMaybe(
            `On ${getDayName(specificDay)}: ${classes.length} class${classes.length > 1 ? 'es' : ''} — ${classList}.`,
            userName
          );
        } else {
          reply = addressMaybe(`${getDayName(specificDay)} is free — no classes scheduled.`, userName);
        }
      }
      
      // =========================================
      // FREE DAY QUERY
      // =========================================
      else if (
        lowerMessage.includes('free') || 
        lowerMessage.includes('off day') || 
        lowerMessage.includes('day off') ||
        lowerMessage.includes('which day')
      ) {
        const freeDays = [];
        for (let i = 0; i < 7; i++) {
          if (getClassesForDay(i).length === 0) {
            freeDays.push(getDayName(i));
          }
        }
        
        if (freeDays.length > 0) {
          reply = addressMaybe(`You're free on: ${freeDays.join(', ')}.`, userName);
        } else {
          reply = addressMaybe("You have classes every day this week — no full free days.", userName);
        }
      }
      
      // =========================================
      // WEEKLY SCHEDULE (DEFAULT)
      // =========================================
      else if (lowerMessage.includes('week') || lowerMessage.includes('weekly')) {
        if (analysis.totalClasses > 0) {
          const lines = ["Here's your week:"];
          for (let i = 0; i < 7; i++) {
            const classes = getClassesForDay(i);
            const dayName = getDayName(i);
            const todayMarker = i === normalizedTodayIndex ? ' (today)' : '';
            const classCount = classes.length;
            lines.push(`${dayName}${todayMarker}: ${classCount} class${classCount !== 1 ? 'es' : ''}`);
          }
          reply = addressMaybe(lines.join(' '), userName);
        } else {
          reply = addressMaybe("No classes scheduled this week — a completely free week.", userName);
        }
      }
      
      // =========================================
      // FALLBACK - SHOW TODAY
      // =========================================
      else {
        if (todayClasses.length > 0) {
          const classList = todayClasses.map(c => c.name || c.subject || 'class').join(', ');
          reply = addressMaybe(
            `Today: ${todayClasses.length} class${todayClasses.length > 1 ? 'es' : ''} — ${classList}.`,
            userName
          );
        } else {
          reply = addressMaybe("No classes today. Want to know about tomorrow or the rest of the week?", userName);
        }
      }
    }

    // 👋 GREETINGS - WITH PROBABILISTIC NAME USAGE
    else if (
      lowerMessage.includes('hi') || 
      lowerMessage.includes('hello') || 
      lowerMessage.includes('hey') ||
      sanitizedMessage.trim() === ''
    ) {
      intent = 'GREETING';
      const todayClasses = getClassesForDay(normalizedTodayIndex);
      
      const timeOfDay = now.getHours();
      let greeting = 'Hello';
      if (timeOfDay < 12) greeting = 'Good morning';
      else if (timeOfDay < 17) greeting = 'Good afternoon';
      else greeting = 'Good evening';
      
      // Probabilistic name usage for greetings (50% chance)
      const greetingLine = Math.random() < 0.5
        ? `${greeting}, ${userName}.`
        : `${greeting}.`;
      
      const parts = [
        greetingLine,
        todayClasses.length > 0
          ? `You have ${todayClasses.length} class${todayClasses.length > 1 ? 'es' : ''} today.`
          : "You're free today — no classes scheduled.",
        assignmentCount > 0
          ? `${assignmentCount} pending assignment${assignmentCount > 1 ? 's' : ''}.`
          : null,
        attendance.totalHeld > 0
          ? `Attendance at ${attendance.percentage}%.`
          : null,
        expenses.thisMonth > 0
          ? `Spent ₹${expenses.thisMonth.toFixed(2)} this month.`
          : null,
        "Let me know if you need anything specific."
      ].filter(Boolean);
      
      reply = formatReply(parts);
    }

    // 😊 GRATITUDE
    else if (
      lowerMessage.includes('thank') || 
      lowerMessage.includes('thanks') ||
      lowerMessage.includes('appreciate')
    ) {
      intent = 'GRATITUDE';
      reply = addressMaybe("Happy to help. Let me know if you need anything else.", userName);
    }

    // 🤖 DEFAULT GUIDANCE
    else {
      intent = 'GUIDANCE';
      
      reply = addressMaybe(
        "I can help you check your schedule, assignments, attendance, expenses, or calendar. Just ask — like 'how busy is my week' or 'when's my next exam'.",
        userName
      );
    }

    // Development logging
    if (DEBUG) {
      console.log('[Assistant] Response:', { 
        intent, 
        userName,
        replyLength: reply.length
      });
    }

    return res.status(200).json({
      intent,
      reply,
      metadata: {
        timestamp: now.toISOString(),
        userName,
        dataUsed: {
          hasExpenses: !!expenses && Object.keys(expenses).length > 0,
          hasAttendance: !!attendance && attendance.totalHeld > 0,
          hasTimetable: Object.keys(timetable).length > 0,
          hasAssignments: assignmentCount > 0,
          hasCalendar: calendarMarks.length > 0,
          hasCgpa: cgpa.length > 0
        }
      }
    });

  } catch (error) {
    console.error('[Assistant] Error:', error?.message || error);
    return res.status(500).json({ 
      intent: 'ERROR',
      reply: "Something went wrong. Could you try that again?",
      error: DEBUG ? error.message : undefined
    });
  }
});

export default router;