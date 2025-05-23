const NotificationStatus = {
    APPLIED: 'Applied',
    ASSESSMENT: 'Assessment',
    INTERVIEW_SCHEDULED: 'Interview Scheduled',
    INTERVIEW_COMPLETE: 'Interview Complete',
    OFFER: 'Offer',
    REJECTED: 'Rejected',
    ALL: 'All',
};

export const subjectTemplates = {
    [NotificationStatus.APPLIED]: [
        "Application Received for {title} at {company}",
        "Thanks for applying to {company}",
        "We’ve received your application - {company}",
        "Your application is under review at {company}",
        "Next steps for {title} at {company}",
        "Your resume has been submitted - {company}",
        "Acknowledgment of your application - {company}",
        "Job Application Confirmation - {company}",
        "We’re reviewing your application at {company}",
        "Thanks for your interest in {company}",
        "Your profile is being reviewed - {company}",
        "We’ve got your resume - {company}",
        "Update on your job application - {company}",
        "Application for {title} at {company}",
        "Submission received - {company}",
        "We appreciate your interest in {company}",
        "Job applied: {title} at {company}",
        "You’ve successfully applied to {company}",
        "Resume submitted: {title}",
        "Waiting to hear back from {company}",
    ],
    [NotificationStatus.ASSESSMENT]: [
        "Assessment Required for {title} at {company}",
        "Next Step: Online Assessment from {company}",
        "Please complete your assessment for {title}",
        "Assessment Invitation - {company}",
        "Assessment link for {title}",
        "Your task for the {title} role at {company}",
        "Online evaluation from {company}",
        "Follow-up task from {company}",
        "Assessment Instructions Inside",
        "Let's test your skills - {company}",
        "You're invited to an assessment - {company}",
        "Pre-interview task: {title}",
        "Ready to complete your test for {company}?",
        "Skill assessment from {company}",
        "Homework for {title} role",
        "We’re excited to see your solution!",
        "Complete this assignment to move forward",
        "Challenge from {company}",
        "Step 2: Assessment for {title}",
        "Test your fit with {company}",
    ],
    [NotificationStatus.INTERVIEW_SCHEDULED]: [
        "Interview Scheduled with {company}",
        "Interview Invitation for {title}",
        "Your interview at {company} is confirmed",
        "Meeting Scheduled: {title} role",
        "Interview Booking Details Inside",
        "Mark your calendar for your interview",
        "Excited to meet you - Interview Scheduled",
        "Interview Prep & Info",
        "Zoom Interview Scheduled with {company}",
        "Let's talk - Interview on the way",
        "You’re set to meet our team",
        "Here’s your interview date",
        "Upcoming Interview: {title} at {company}",
        "Interview slot locked in",
        "Details for your chat with {company}",
        "First round interview invitation",
        "Your schedule for {title} interview",
        "You're one step closer!",
        "Meeting scheduled for the {title} role",
        "Interview calendar invite enclosed",
    ],
    [NotificationStatus.INTERVIEW_COMPLETE]: [
        "Thanks for interviewing with {company}",
        "Interview for {title} completed",
        "Your feedback from {company}",
        "We appreciate your time",
        "Thanks for speaking with us",
        "Interview Done - Next Steps Soon",
        "Great chatting with you!",
        "Appreciate your time with {company}",
        "Post-interview update",
        "Your interview status with {company}",
        "We’ll be in touch soon - {company}",
        "That was great! Thanks!",
        "Interview Summary - {company}",
        "End of Round Feedback",
        "Thanks for meeting the team",
        "We’re reviewing your interview",
        "Final Thoughts from {company}",
        "Interview completed for {title}",
        "Follow-up after your interview",
        "Waiting for the final decision",
    ],
    [NotificationStatus.OFFER]: [
        "Offer from {company}",
        "You’ve been selected for {title}",
        "Congratulations! Offer for {title}",
        "Let’s talk about your offer",
        "Here’s your offer letter",
        "Excited to welcome you aboard!",
        "Join our team - Offer Details",
        "Final Step: Offer Enclosed",
        "Offer Package from {company}",
        "We want you on our team!",
        "Position Offered: {title}",
        "Let’s discuss your future with us",
        "Welcome to {company}!",
        "Your Offer is Ready",
        "Offer Confirmation - {company}",
        "We’d love to have you!",
        "Time to celebrate! 🎉",
        "Let’s get started!",
        "Here's what’s next for you",
        "Congrats! You're in",
    ],
    [NotificationStatus.REJECTED]: [
        "Application Update from {company}",
        "Position Filled at {company}",
        "We’re moving forward with other candidates",
        "Thank you for your interest in {company}",
        "Your application status - {company}",
        "Decision on Your Application",
        "Not a fit this time",
        "We wish you the best",
        "Application Closed - {title}",
        "We’ve decided to move on",
        "This round wasn’t it",
        "Re: Your Job Application",
        "We’ve chosen another path",
        "Update on Hiring Process",
        "You’re not moving forward",
        "Role no longer available",
        "We hope you keep in touch",
        "Application closed - thank you",
        "We had to make a tough choice",
        "Hiring decision made - {company}",
    ],
};

export const bodyTemplates = {
    [NotificationStatus.APPLIED]: [
        "Thank you for applying to {{company}}. We've received your application for the {{position}} role.",
        "We've received your application and will review it soon.",
        "Thanks for your interest in joining {{company}}!",
        "Your application for the {{position}} role has been successfully submitted.",
        "We’ve added your profile to our candidate list.",
        "We appreciate your interest in {{company}}.",
        "You applied for {{position}} at {{company}} — we’re reviewing your background.",
        "Thank you for your submission. We’ll reach out if you're shortlisted.",
        "This email confirms your application to {{company}}.",
        "Our hiring team is reviewing your application.",
        "We’re currently reviewing applications for the {{position}} role.",
        "Your profile is being considered at {{company}}.",
        "Thank you for expressing interest in working with us.",
        "Your resume has been received.",
        "Your journey with {{company}} has officially begun.",
        "We’re happy to have received your application!",
        "Hang tight — our team is reviewing your credentials.",
        "Application received for the position of {{position}}.",
        "Our team has your application and will be in touch.",
        "You’re one step closer to joining {{company}}."
    ],
    [NotificationStatus.ASSESSMENT]: [
        "We’d like you to complete an assessment for the {{position}} role at {{company}}.",
        "Please complete the following task to proceed with your application.",
        "Your assessment is now live. Complete it by {{date}}.",
        "This is your next step in the hiring process.",
        "Our team invites you to take an online test.",
        "Kindly find the assessment link attached.",
        "This task will help us evaluate your skills.",
        "We use assessments to better understand your fit.",
        "Let’s get to know you through a quick exercise.",
        "Please take the coding challenge before {{date}}.",
        "Your profile is promising — complete the test to move forward.",
        "This test helps us assess real-world problem-solving.",
        "An online challenge awaits — see the instructions inside.",
        "Demonstrate your expertise with this task.",
        "Let’s move to the technical phase!",
        "Please check the attached assessment for the {{position}} position.",
        "You’re now invited to our evaluation round.",
        "We’re excited to learn more through this assessment.",
        "Complete this short test as the next step.",
        "We use tests to ensure great matches — give it your best!"
    ]
    ,
    [NotificationStatus.INTERVIEW_SCHEDULED]: [
        "Your interview with {{company}} is scheduled. Please check your calendar.",
        "We’re looking forward to speaking with you!",
        "Here are the details for your upcoming interview.",
        "Get ready! Your interview for the {{position}} is booked.",
        "Your interview is scheduled for {{date}}.",
        "We're excited to connect with you soon.",
        "Prepare to meet our team and discuss the {{position}} role.",
        "You’ll be speaking with our hiring panel.",
        "Join us via Zoom at the scheduled time.",
        "Let us know if you need to reschedule.",
        "You’ll meet with our team lead and recruiter.",
        "This is a reminder for your scheduled interview.",
        "Your interview slot is confirmed.",
        "You’re almost there — we can’t wait to chat!",
        "Be ready with questions and insights.",
        "The interview will focus on your experience and goals.",
        "Expect a 45-minute conversation with our tech team.",
        "This is a virtual interview — link attached.",
        "We’ll assess your fit for {{company}}’s team.",
        "Let’s discuss your future at {{company}}."
    ]
    ,
    [NotificationStatus.INTERVIEW_COMPLETE]: [
        "Thanks for taking the time to interview with us.",
        "We appreciate the opportunity to speak with you.",
        "We enjoyed learning about your background.",
        "Your interview for {{position}} is now complete.",
        "Thanks for a great conversation.",
        "We hope you enjoyed speaking with our team.",
        "We’re currently reviewing your interview feedback.",
        "You’ve completed the interview process for {{position}}.",
        "We’ll get back to you with next steps soon.",
        "Thanks again for considering {{company}}.",
        "It was a pleasure meeting you.",
        "Our team is discussing your candidacy.",
        "We’ll reach out after internal deliberations.",
        "We’re impressed with your qualifications.",
        "You’ve officially completed all interview stages.",
        "You’re in the final review stage now.",
        "We value the insights you shared.",
        "Thank you for your time and professionalism.",
        "You helped us understand your skills better.",
        "We’ll be in touch shortly with an update."
    ]
    ,
    [NotificationStatus.OFFER]: [
        "We are pleased to offer you the {{position}} position at {{company}}.",
        "Congratulations! You’ve been selected for the role.",
        "You’ve made it! We’d love to have you onboard.",
        "Please review the attached offer letter.",
        "We’re thrilled to extend you an offer.",
        "Welcome to the {{company}} team!",
        "You’ve impressed us — now let’s make it official.",
        "We’re offering you a chance to join our growing team.",
        "Your skills are a great fit for our needs.",
        "We’d love to start your onboarding process soon.",
        "Details of your compensation and role are enclosed.",
        "Your journey with {{company}} is about to begin.",
        "It’s offer time — congratulations again!",
        "Here’s your official offer from {{company}}.",
        "Join us and make a difference.",
        "We’re excited to work with you.",
        "You’re our top choice for {{position}}.",
        "The team is eager to have you join.",
        "Let's take this next step together.",
        "Your new career chapter starts now!"
    ]
    ,
    [NotificationStatus.REJECTED]: [
        "After careful consideration, we won’t be moving forward with your application.",
        "We appreciate your interest but have chosen another candidate.",
        "You were not selected for the {{position}} position.",
        "We encourage you to apply again in the future.",
        "Thanks for your time and effort during the process.",
        "Our team has reviewed your profile thoroughly.",
        "We had many strong applicants and made a difficult decision.",
        "This role is now filled, but we’re keeping your resume.",
        "We wish you all the best in your career.",
        "Your qualifications were impressive, but not the right fit.",
        "This is not a reflection of your abilities.",
        "We truly value your interest in {{company}}.",
        "Please don’t hesitate to apply again.",
        "We’ll retain your information for future openings.",
        "It was a pleasure learning more about you.",
        "You brought great value to our process.",
        "Unfortunately, you weren’t selected at this time.",
        "Thanks for engaging with our hiring team.",
        "We wish you continued success.",
        "Thank you for your interest in the {{position}} at {{company}}."
    ]
    ,
};

export const jobTitles = [
    "Frontend Developer", "Backend Engineer", "Full Stack Developer", "Data Scientist",
    "Machine Learning Engineer", "DevOps Engineer", "Product Manager", "UX Designer",
    "Mobile Developer", "QA Tester", "Solutions Architect", "Cloud Engineer", "Game Developer",
    "IT Support Specialist", "Technical Writer", "Database Administrator", "Cybersecurity Analyst",
    "Network Engineer", "AI Researcher", "Web Developer", "Site Reliability Engineer", "Business Analyst",
    "Growth Engineer", "CRM Specialist", "Integration Engineer", "Platform Engineer", "VR Developer",
    "Blockchain Developer", "Firmware Engineer", "Systems Analyst"
];

export const companies = [
    "TechNova", "ByteSpark", "InnoCore", "LoopWorks", "Nimbus", "GreenByte", "Zentry", "HelixAI",
    "PulseSoft", "Quanta", "CloudHive", "Lumina", "Nexovate", "SkyGrid", "Altura", "BrightStack",
    "DeepLayer", "Neurobit", "Flexora", "Omnisync", "RedMatter", "Codexa", "Sparkline", "CyberNest",
    "ZenithTech", "GloboSoft", "CoreLink", "QubitFlow", "NovaFusion", "StreamForge"
];

export const locations = [
    "Remote", "New York", "San Francisco", "Austin", "Seattle", "Toronto", "Berlin", "London",
    "Amsterdam", "Stockholm", "Singapore", "Sydney", "Chicago", "Boston", "Denver", "Los Angeles",
    "Paris", "Madrid", "Dubai", "Dublin", "Vancouver", "Tokyo", "Melbourne", "Oslo", "Rome",
    "Lisbon", "Tel Aviv", "Warsaw", "Zurich", "Cape Town"
];