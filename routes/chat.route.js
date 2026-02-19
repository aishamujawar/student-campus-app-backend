import express from 'express';

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

// NEW: Paragraph builder for natural flow
function paragraph(lines) {
  return lines.filter(Boolean).join(' ');
}

// NEW: User addressing helper
function addressUser(text, userName) {
  return `${userName}, ${text}`;
}

router.post('/chat', async (req, res) => {
  try {
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

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        error: 'Message is required',
        intent: 'ERROR'
      });
    }

    // NEW: Get user name
    const userName = user.firstName || 'there';

    // Development logging only
    if (DEBUG) {
      console.log('[Assistant] Received query:', {
        userName,
        message: message.substring(0, 50),
        expensesThisMonth: expenses.thisMonth || 0
      });
    }

    const lowerMessage = message.toLowerCase();
    let reply = '';
    let intent = 'GENERAL_QUERY';
    
    // Calculate day index (Monday=0)
    const jsTodayIndex = new Date().getDay();
    const normalizedTodayIndex = jsTodayIndex === 0 ? 6 : jsTodayIndex - 1;
    
    // Calculate assignment count once
    const assignmentCount = Object.values(assignments).reduce((sum, count) => sum + count, 0);
    
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

    // 🎯 HIGHEST PRIORITY: MONTHLY EXPENSE QUERY
    if (
      lowerMessage.includes('this month') &&
      (lowerMessage.includes('spend') || lowerMessage.includes('expense'))
    ) {
      intent = 'EXPENSE_MONTHLY';

      if (!expenses || typeof expenses.thisMonth !== 'number') {
        reply = addressUser("No expense data available for this month.", userName);
      } else {
        reply = paragraph([
          addressUser(`you've spent ₹${expenses.thisMonth.toFixed(2)} so far this month.`, userName),
          expenses.thisMonth > 10000
            ? "Spending is on the higher side, so keeping an eye on discretionary expenses would help."
            : "Your spending looks reasonably controlled at the moment."
        ]);
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
        reply = addressUser("No expense records found. Start tracking expenses to manage your budget.", userName);
      } else {
        const total = expenses.total || 0;
        const thisMonth = expenses.thisMonth || 0;
        const categories = expenses.categories || {};

        const replyLines = [
          addressUser(`overall spending is ₹${total.toFixed(2)}, with ₹${thisMonth.toFixed(2)} this month.`, userName)
        ];

        // Budget insights
        if (thisMonth > 10000) {
          replyLines.push("This month's spending is above average. Consider reviewing discretionary expenses.");
        } else if (thisMonth > 5000) {
          replyLines.push("Monthly spending is within moderate range.");
        } else if (thisMonth > 0) {
          replyLines.push("Your current spending pace is manageable.");
        }

        // Show top categories if available
        if (Object.keys(categories).length > 0) {
          const sortedCategories = Object.entries(categories)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);

          if (sortedCategories.length > 0) {
            replyLines.push("Primary spending categories:");
            sortedCategories.forEach(([cat, amt]) => {
              const percentage = total > 0 ? ((amt / total) * 100).toFixed(1) : 0;
              replyLines.push(`• ${cat}: ₹${amt.toFixed(2)} (${percentage}%)`);
            });
          }
        }

        reply = formatReply(replyLines);
      }
    }

    // 📊 ATTENDANCE INSIGHTS
    else if (
      lowerMessage.includes('attendance') ||
      lowerMessage.includes('present') ||
      lowerMessage.includes('absent') ||
      lowerMessage.includes('percentage')
    ) {
      intent = 'ATTENDANCE_INSIGHTS';

      if (!attendance || attendance.totalHeld === 0) {
        reply = addressUser("No attendance records available yet.", userName);
      } else {
        const percentage = attendance.percentage;
        const attended = attendance.totalAttended;
        const held = attendance.totalHeld;

        const replyLines = [
          addressUser(`your attendance is currently at ${percentage}% (${attended} of ${held} classes).`, userName)
        ];

        if (percentage < 75) {
          replyLines.push("This is below the recommended threshold of 75%.");
          const needed = Math.ceil(held * 0.75) - attended;
          if (needed > 0) {
            replyLines.push(`You need to attend ${needed} more classes to reach 75%.`);
          }
        } else if (percentage < 85) {
          replyLines.push("This is acceptable, but could be improved for better academic standing.");
        } else {
          replyLines.push("This is at a good level for academic requirements.");
        }

        reply = paragraph(replyLines);
      }
    }

    // 🎓 ACADEMIC PERFORMANCE
    else if (
      lowerMessage.includes('cgpa') || 
      lowerMessage.includes('gpa') || 
      lowerMessage.includes('grade') ||
      lowerMessage.includes('sgpa') ||
      lowerMessage.includes('semester') ||
      lowerMessage.includes('marks') ||
      lowerMessage.includes('performance')
    ) {
      intent = 'ACADEMIC_INSIGHTS';
      
      if (cgpa.length > 0) {
        const latest = cgpa[cgpa.length - 1];
        const sgpa = latest.sgpa || latest.gpa || latest.score;
        
        if (lowerMessage.includes('trend') || lowerMessage.includes('progress')) {
          if (cgpa.length > 1) {
            const first = cgpa[0].sgpa || cgpa[0].gpa || cgpa[0].score;
            const difference = sgpa - first;
            
            reply = paragraph([
              addressUser(`your academic progress shows a current SGPA of ${sgpa.toFixed(2)}`, userName),
              `starting from ${first.toFixed(2)}`,
              difference >= 0 
                ? `with an improvement of +${difference.toFixed(2)} over ${cgpa.length} semesters.`
                : `with a change of ${difference.toFixed(2)} over ${cgpa.length} semesters.`
            ]);
          } else {
            reply = addressUser(`your current SGPA is ${sgpa.toFixed(2)} (based on 1 semester).`, userName);
          }
        } else {
          reply = paragraph([
            addressUser(`your latest SGPA is ${sgpa.toFixed(2)}`, userName),
            `based on ${cgpa.length} semester${cgpa.length > 1 ? 's' : ''} of data.`
          ]);
        }
      } else {
        reply = addressUser("No academic records available. Add semester grades to track performance.", userName);
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
        reply = addressUser("No pending assignments.", userName);
        return res.json({ intent, reply });
      }

      const assignmentDates = Object.keys(assignments);
      const sortedDates = assignmentDates.sort();
      const now = new Date();
      
      if (lowerMessage.includes('week') || lowerMessage.includes('this week')) {
        const weekAssignments = sortedDates.filter(date => {
          const daysUntil = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
          return daysUntil >= 0 && daysUntil <= 7;
        });
        
        if (weekAssignments.length > 0) {
          const replyLines = [addressUser("here are assignments due this week:", userName)];
          weekAssignments.forEach(date => {
            const count = assignments[date];
            const daysUntil = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
            replyLines.push(`• ${date}: ${count} assignment${count > 1 ? 's' : ''} (${daysUntil} days)`);
          });
          reply = formatReply(replyLines);
        } else {
          reply = addressUser("No assignments due this week.", userName);
        }
      }
      
      else if (lowerMessage.includes('next') || lowerMessage.includes('upcoming')) {
        const nextDate = sortedDates[0];
        const nextCount = assignments[nextDate];
        const daysUntil = Math.ceil((new Date(nextDate) - now) / (1000 * 60 * 60 * 24));
        
        reply = paragraph([
          addressUser(`your next deadline is ${nextDate}`, userName),
          `with ${nextCount} assignment${nextCount > 1 ? 's' : ''} due in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}.`
        ]);
      }
      
      else {
        const nearestDate = sortedDates[0];
        const nearestCount = assignments[nearestDate];
        const daysUntil = Math.ceil((new Date(nearestDate) - now) / (1000 * 60 * 60 * 24));
        
        reply = paragraph([
          addressUser(`you have ${assignmentCount} pending assignment${assignmentCount > 1 ? 's' : ''}`, userName),
          `with the nearest due on ${nearestDate} (${daysUntil} days)`,
          `for ${nearestCount} assignment${nearestCount > 1 ? 's' : ''}.`
        ]);
      }
    }

    // 📅 CALENDAR & EVENTS (FIXED EXAM DETECTION)
    else if (
      lowerMessage.includes('calendar') || 
      lowerMessage.includes('event') || 
      lowerMessage.includes('exam') ||
      lowerMessage.includes('important date') ||
      lowerMessage.includes('meeting')
    ) {
      intent = 'CALENDAR_MANAGEMENT';
      
      if (calendarMarks.length === 0) {
        reply = addressUser("No important dates in calendar.", userName);
        return res.json({ intent, reply });
      }

      const sortedDates = calendarMarks.sort();
      const now = new Date();
      
      if (lowerMessage.includes('exam')) {
        // FIXED: Use structured category data instead of string guessing
        const examDates = calendarMarks.filter(d => {
          // Assuming calendarMarks is array of objects with categoryName
          const category = d.categoryName?.toLowerCase() || d.toLowerCase();
          return category.includes('exam') || category.includes('test');
        });
        
        if (examDates.length > 0) {
          const replyLines = [addressUser("your exam schedule:", userName)];
          examDates.forEach((date, index) => {
            const daysUntil = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
            replyLines.push(`${index + 1}. ${date} (${daysUntil} days)`);
          });
          reply = formatReply(replyLines);
        } else {
          reply = addressUser(`found ${calendarMarks.length} important dates, none specifically marked as exams.`, userName);
        }
      }
      
      else if (lowerMessage.includes('next') || lowerMessage.includes('upcoming')) {
        const nextDate = sortedDates[0];
        const daysUntil = Math.ceil((new Date(nextDate) - now) / (1000 * 60 * 60 * 24));
        
        reply = paragraph([
          addressUser(`your next important date is ${nextDate}`, userName),
          `which is ${daysUntil} day${daysUntil !== 1 ? 's' : ''} from now.`
        ]);
      }
      
      else {
        if (calendarMarks.length <= 3) {
          const replyLines = [addressUser("important calendar dates:", userName)];
          calendarMarks.forEach((date, index) => {
            const daysUntil = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
            replyLines.push(`${index + 1}. ${date} (${daysUntil >= 0 ? daysUntil + ' days' : 'passed'})`);
          });
          reply = formatReply(replyLines);
        } else {
          const upcoming = sortedDates.slice(0, 3);
          const replyLines = [
            addressUser(`you have ${calendarMarks.length} important dates. Here are the upcoming ones:`, userName)
          ];
          upcoming.forEach((date, index) => {
            const daysUntil = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
            replyLines.push(`${index + 1}. ${date} (${daysUntil} days)`);
          });
          reply = formatReply(replyLines);
        }
      }
    }

    // ⏰ TIMETABLE & SCHEDULE (WITH ANALYSIS)
    else if (
      lowerMessage.includes('class') || 
      lowerMessage.includes('lecture') || 
      lowerMessage.includes('timetable') ||
      lowerMessage.includes('schedule') ||
      lowerMessage.includes('tomorrow') ||
      lowerMessage.includes('today') ||
      lowerMessage.includes('free day') ||
      lowerMessage.includes('week') ||
      lowerMessage.includes('busy') ||
      lowerMessage.includes('packed')
    ) {
      intent = 'TIMETABLE_ANALYSIS';
      const analysis = analyzeWeeklyPattern();
      const todayClasses = getClassesForDay(normalizedTodayIndex);
      const tomorrowClasses = getClassesForDay((normalizedTodayIndex + 1) % 7);
      
      const dayMap = {
        'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
        'friday': 4, 'saturday': 5, 'sunday': 6
      };

      let specificDay = null;
      for (const [day, index] of Object.entries(dayMap)) {
        if (lowerMessage.includes(day)) {
          specificDay = index;
          break;
        }
      }
      
      if (lowerMessage.includes('tomorrow')) {
        if (tomorrowClasses.length > 0) {
          const classList = tomorrowClasses.map(c => c.name || c.subject || 'class').join(', ');
          reply = paragraph([
            addressUser(`tomorrow you have ${tomorrowClasses.length} class${tomorrowClasses.length > 1 ? 'es' : ''}`, userName),
            `(${classList}).`
          ]);
        } else {
          reply = addressUser("No classes scheduled for tomorrow.", userName);
        }
      }
      
      else if (lowerMessage.includes('today')) {
        if (todayClasses.length > 0) {
          const classList = todayClasses.map(c => c.name || c.subject || 'class').join(', ');
          reply = paragraph([
            addressUser(`today you have ${todayClasses.length} class${todayClasses.length > 1 ? 'es' : ''}`, userName),
            `(${classList}).`
          ]);
        } else {
          reply = addressUser("No classes scheduled today.", userName);
        }
      }
      
      else if (specificDay !== null) {
        const classes = getClassesForDay(specificDay);
        if (classes.length > 0) {
          const classList = classes.map(c => c.name || c.subject || 'class').join(', ');
          reply = paragraph([
            addressUser(`on ${getDayName(specificDay)} you have ${classes.length} class${classes.length > 1 ? 'es' : ''}`, userName),
            `(${classList}).`
          ]);
        } else {
          reply = addressUser(`No classes scheduled for ${getDayName(specificDay)}.`, userName);
        }
      }
      
      else if (lowerMessage.includes('free') || lowerMessage.includes('which day')) {
        const freeDays = [];
        for (let i = 0; i < 7; i++) {
          if (getClassesForDay(i).length === 0) {
            freeDays.push(getDayName(i));
          }
        }
        
        if (freeDays.length > 0) {
          reply = addressUser(`days without classes: ${freeDays.join(', ')}.`, userName);
        } else {
          reply = addressUser("Classes scheduled every day this week.", userName);
        }
      }
      
      else if (lowerMessage.includes('busiest') || lowerMessage.includes('most busy')) {
        if (analysis.busiestDay.day !== null) {
          const dayName = getDayName(analysis.busiestDay.day);
          reply = paragraph([
            addressUser(`the busiest day is ${dayName}`, userName),
            `with ${analysis.busiestDay.count} classes.`
          ]);
        } else {
          reply = addressUser("Schedule is evenly balanced across the week.", userName);
        }
      }
      
      else if (lowerMessage.includes('week') || lowerMessage.includes('weekly')) {
        if (analysis.totalClasses > 0) {
          if (lowerMessage.includes('packed') || lowerMessage.includes('busy')) {
            // WEEK ANALYSIS WITH JUDGEMENT
            reply = paragraph([
              addressUser(`your week includes ${analysis.totalClasses} classes spread across ${analysis.daysWithClasses} days.`, userName),
              analysis.totalClasses >= 6
                ? "It's a fairly busy week, especially toward the heavier days."
                : "The workload looks manageable if you plan ahead.",
              analysis.busiestDay.day !== null
                ? `The busiest day is ${getDayName(analysis.busiestDay.day)}.`
                : null
            ]);
          } else {
            // WEEKLY SCHEDULE LISTING
            const replyLines = [addressUser("weekly schedule:", userName)];
            for (let i = 0; i < 7; i++) {
              const classes = getClassesForDay(i);
              const dayName = getDayName(i);
              const todayMarker = i === normalizedTodayIndex ? ' (Today)' : '';
              replyLines.push(`${dayName}${todayMarker}: ${classes.length} classes`);
            }
            replyLines.push(`Total: ${analysis.totalClasses} classes across ${analysis.daysWithClasses} days`);
            reply = formatReply(replyLines);
          }
        } else {
          reply = addressUser("No classes scheduled this week.", userName);
        }
      }
      
      else {
        if (todayClasses.length > 0) {
          const classList = todayClasses.map(c => c.name || c.subject || 'class').join(', ');
          reply = paragraph([
            addressUser(`today you have ${todayClasses.length} class${todayClasses.length > 1 ? 'es' : ''}`, userName),
            `(${classList}).`
          ]);
        } else {
          reply = addressUser("No classes scheduled today. Ask about specific days or the weekly schedule.", userName);
        }
      }
    }

    // 👋 GREETINGS (PERSONALIZED)
    else if (
      lowerMessage.includes('hi') || 
      lowerMessage.includes('hello') || 
      lowerMessage.includes('hey') ||
      lowerMessage === ''
    ) {
      intent = 'GREETING';
      const todayClasses = getClassesForDay(normalizedTodayIndex);
      const tomorrowClasses = getClassesForDay((normalizedTodayIndex + 1) % 7);
      
      const timeOfDay = new Date().getHours();
      let greeting = 'Hello';
      if (timeOfDay < 12) greeting = 'Good morning';
      else if (timeOfDay < 17) greeting = 'Good afternoon';
      else greeting = 'Good evening';
      
      reply = formatReply([
        `${greeting}, ${userName}.`,
        "",
        "Here's a quick overview of where things stand today:",
        todayClasses.length > 0
          ? `• You have ${todayClasses.length} class${todayClasses.length > 1 ? 'es' : ''} today`
          : "• You don't have any classes today",
        assignmentCount > 0
          ? `• ${assignmentCount} pending assignment${assignmentCount > 1 ? 's' : ''}`
          : null,
        attendance.totalHeld > 0
          ? `• Attendance is currently at ${attendance.percentage}%`
          : null,
        expenses.thisMonth > 0
          ? `• ₹${expenses.thisMonth.toFixed(2)} spent this month`
          : null,
      ]);
    }

    // 😊 GRATITUDE
    else if (
      lowerMessage.includes('thank') || 
      lowerMessage.includes('thanks') ||
      lowerMessage.includes('appreciate')
    ) {
      intent = 'GRATITUDE';
      reply = addressUser("you're welcome. Let me know if you need assistance with anything else.", userName);
    }

    // 🤖 DEFAULT GUIDANCE (CLEANER)
    else {
      intent = 'GUIDANCE';
      
      reply = paragraph([
        addressUser("I can help you analyse your schedule, assignments, attendance, expenses, and important dates.", userName),
        "You can ask things like:",
        "How busy is my week, am I low on attendance, or how my spending looks this month."
      ]);
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
        timestamp: new Date().toISOString(),
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
    console.error('[Assistant] Error:', error);
    return res.status(500).json({ 
      intent: 'ERROR',
      reply: "Unable to process your request. Please try again.",
      error: DEBUG ? error.message : undefined
    });
  }
});

export default router;