# JobPulse Backend

JobPulse is an email-based job tracking tool that integrates with Discord to help users manage and monitor their job applications efficiently. This repository contains the backend service built using Node.js and Express, connected to a lightweight SQLite database and Redis for temporary state handling. The backend handles email polling, user session management, integrations, and webhook processing.

🌐 **Live Frontend:** [job.vercel.app](https://job.vercel.app)  
📦 **Frontend Repo:** [jeffawe/Frontend](https://github.com/jeffawe/Frontend)

---

## 🚀 Features

- Gmail email polling and parsing.
- Google Pub/Sub webhook listener.
- Discord bot integration for job tracking.
- Redis caching and session state handling.
- Secure JWT-based authentication.
- Supabase integration for cloud storage.
- Simple deployment with Docker.

---

## 🧩 Tech Stack

- **Node.js** / **Express.js**
- **SQLite** (via Docker)
- **Redis**
- **Google Cloud Pub/Sub**
- **Supabase**
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
