import seedrandom from 'seedrandom';
import { jobTitles, companies, subjectTemplates, bodyTemplates } from './testData.js';

// Helper to get a seeded random generator
const getSeededRandom = (userId) => seedrandom(userId);

// Get a random item from an array using a seeded RNG
const getRandomSeeded = (arr, rng) => {
  return arr[Math.floor(rng() * arr.length)];
};

// Get a random date within the last N days using a seeded RNG
const randomDateWithinLastNDaysSeeded = (n, rng) => {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(rng() * n));
  return date;
};

// Create map from NotificationStatus to templates
const statusEmailMap = Object.keys(subjectTemplates).reduce((acc, status) => {
  acc[status] = {
    subjects: subjectTemplates[status],
    bodies: bodyTemplates[status],
  };
  return acc;
}, {});

export const getTestUserEmails = async (userId) => {
  try {
    const rng = getSeededRandom(userId); // Seeded RNG
    const count = Math.floor(rng() * 6) + 5; // 5–10 emails
    const emails = [];

    for (let i = 0; i < count; i++) {
      const statusKeys = Object.keys(statusEmailMap);
      const status = getRandomSeeded(statusKeys, rng);
      const { subjects, bodies } = statusEmailMap[status];

      const title = getRandomSeeded(jobTitles, rng);
      const company = getRandomSeeded(companies, rng);
      const subject = getRandomSeeded(subjects, rng)
        .replace('{company}', company)
        .replace('{title}', title);

      const body = getRandomSeeded(bodies, rng)
        .replace('{{company}}', company)
        .replace('{{position}}', title)
        .replace('{{date}}', randomDateWithinLastNDaysSeeded(30, rng).toLocaleDateString());

      emails.push({
        subject,
        from: `hr@${company.toLowerCase().replace(/\s+/g, '')}.com`,
        body,
        date: randomDateWithinLastNDaysSeeded(30, rng),
        status,
      });
    }
    return emails;
  } catch (error) {
    console.error("Error generating test emails:", error);
    return [];
  }
};
