# JobPulse Backend

JobPulse is an email-based job tracking tool that integrates with Discord to help users manage and monitor their job applications efficiently. This repository contains the backend service built using Node.js and Express, connected to a lightweight SQLite database and Redis for temporary state handling. The backend handles email polling, user session management, integrations, and webhook processing.

🌐 **Live Frontend:** [Job Pulse](https://job-pulse1.vercel.app)  
📦 **Frontend Repo:** [Frontend](https://github.com/Jeffawe/JobPulse)

---

## 🚀 Features

- Gmail email polling and parsing.
- Google Pub/Sub webhook listener.
- Discord bot integration for job tracking.
- Redis caching and session state handling.
- Secure JWT-based authentication.
- Simple deployment with Docker.
- Natural Language Processing

---

## 🧩 Tech Stack

- **Node.js** / **Express.js**
- **SQLite** (via Docker)
- **Redis**
- **Google Cloud Pub/Sub**
- **Docker / Docker Compose**

---

## 🛠️ Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- Docker & Docker Compose

---

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/JobPulse-Backend.git
cd JobPulse-Backend
```

### 2. Set Up Environment Variables

```bash
JWT_SECRET=Set Values
EMAIL_POLL_INTERVAL_MINUTES=Set Values
GOOGLE_CLOUD_PROJECT_ID=Set Values
PUBSUB_TOPIC_NAME=Set Values
GOOGLE_CLIENT_ID=Set Values
GOOGLE_CLIENT_SECRET=Set Values
REDIS_TLS='true'
REDIS_PASSWORD=Set Values
API_KEY=Set Values
REDIS_HOST=Set Values
REDIS_PORT=Set Values
PORT=Set Values
NODE_ENV=Set Values
GOOGLE_REDIRECT_URI=Set Values
BOT_SECRET=Set Values
BOT_URL=Set Values
ENCRYPTION_KEY=Set Values
DISCORD_WEBHOOK_URL=Set Values
DB_STATE="local"
