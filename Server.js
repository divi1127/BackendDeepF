const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

const app = express();
require("dotenv").config();

// ------------------ CORS ------------------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(bodyParser.json());

// ------------------ UPLOADS ------------------
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = [".pdf", ".doc", ".docx"].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error("Invalid file type"), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ------------------ MYSQL ------------------
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

db.getConnection()
  .then(() => console.log("✅ MySQL Connected..."))
  .catch((err) => console.error("❌ MySQL Connection Error:", err));

// ------------------ EMAIL ------------------
let transporter = null;

try {
  transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
} catch (err) {
  console.warn("⚠️ Email transporter not configured properly:", err.message);
}

async function sendMailSafe(to, subject, html) {
  if (!transporter) {
    console.warn(`⚠️ Skipping email to ${to} - transporter not configured`);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"Deep Learner Academy"<${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error(`⚠️ Failed to send email to ${to}:`, err.message);
  }
}

// ------------------ COURSES ------------------
app.get("/api/courses", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM courses");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/api/courses/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [results] = await db.execute("SELECT * FROM courses WHERE id = ?", [id]);
    if (!results.length) return res.status(404).json({ error: "Course not found" });

    let course = results[0];
    if (course.syllabus && typeof course.syllabus === "string") {
      try { course.syllabus = JSON.parse(course.syllabus); } catch { course.syllabus = []; }
    }
    res.json(course);
  } catch (err) {
    console.error("❌ Error fetching course by ID:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------ ENROLL ------------------
app.post("/api/enroll", async (req, res) => {
  const { name, email, phone, status = "Pending", courseId } = req.body;
  if (!name || !email || !phone || !courseId)
    return res.status(400).json({ success: false, message: "All fields are required" });

  try {
    const [result] = await db.query(
      "INSERT INTO enrollments (name, email, phone, status, course_id) VALUES (?, ?, ?, ?, ?)",
      [name, email, phone, status, courseId]
    );

    // Send emails safely
    await sendMailSafe(
      "deeplearneracademy@gmail.com",
      "📩 New Enrollment",
      `<h2>${name} enrolled in Course ID: ${courseId}</h2>
       <p>Email: ${email}</p>
       <p>Phone: ${phone}</p>
       <p>Status: ${status}</p>`
    );

    await sendMailSafe(
      email,
      "✅ Enrollment Successful",
      `<h2>Hi ${name},</h2>
       <p>You are successfully enrolled in course ID: ${courseId}! 🎉</p>
       <p>Our team will contact you soon.</p>
       <br/>- Deep Learner Academy Team`
    );

    res.status(201).json({
      success: true,
      message: "Enrollment successful, confirmation email sent",
      enrollmentId: result.insertId,
    });
  } catch (err) {
    console.error("Enrollment Error:", err);
    res.status(500).json({ success: false, message: "Server error, please try again later" });
  }
});

// ------------------ USERS ------------------
app.get("/api/users", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM users");
    res.json({ success: true, users: results });
  } catch (err) {
    res.status(500).json({ success: false, message: "DB error" });
  }
});

// Signup
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const [existing] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (existing.length > 0) return res.status(400).json({ message: "User already exists" });

    await db.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [
      name,
      email,
      password,
    ]);
    res.json({ message: "Signup successful!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Login
// Step 1: Request OTP
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await db.query("SELECT * FROM users WHERE email = ? AND password = ?", [email, password]);
    if (!rows.length) return res.status(400).json({ message: "Invalid email or password" });

    const user = rows[0];
    
    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins
    
    // Save OTP to DB
    await db.query("INSERT INTO user_otps (email, otp, expires_at) VALUES (?, ?, ?)", [email, otp, expiresAt]);
    
    // Send OTP email
    await sendMail(email, "Your OTP Code", `<h2>Your OTP is ${otp}</h2>`);

    res.json({ message: "OTP sent to your email" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Step 2: Verify OTP
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  try {
    const [rows] = await db.query(
      "SELECT * FROM user_otps WHERE email = ? AND otp = ? AND expires_at > NOW()",
      [email, otp]
    );

    if (!rows.length) return res.status(400).json({ message: "Invalid or expired OTP" });

    // OTP is correct, delete it
    await db.query("DELETE FROM user_otps WHERE email = ?", [email]);

    // Fetch user info
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    const user = users[0];

    // Generate token (replace with real JWT)
    const token = "FAKE-JWT-TOKEN";

    res.json({ message: "Login successful", token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------ WORKSHOPS ------------------
app.get("/api/workshops", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM workshops");
    res.json({ success: true, workshops: results });
  } catch (err) {
    res.status(500).json({ success: false, message: err });
  }
});

app.post("/api/register", async (req, res) => {
  const { name, email, phone, currentStatus, workshop } = req.body;
  if (!name || !email || !phone || !workshop)
    return res.status(400).json({ success: false, message: "All fields are required" });

  try {
    await db.query(
      "INSERT INTO registrations (name, email, phone, current_status, workshop_title) VALUES (?, ?, ?, ?, ?)",
      [name, email, phone, currentStatus, workshop]
    );
    await sendMail(
      "deeplearneracademy@gmail.com",
      "📩 New Workshop Registration",
      `<h2>${name} registered for ${workshop}</h2>
       <p>Email: ${email}</p>
       <p>Phone: ${phone}</p>
       <p>Status: ${currentStatus}</p>`
    );
    await sendMail(
      email,
      `✅ Registered for ${workshop}`,
      `<h2>Hi ${name},</h2>
       <p>You have successfully registered for <strong>${workshop}</strong>.</p>
       <p>We will contact you soon.</p>
       <br/>Deep learner Academy Team`
    );
    res.json({ success: true, message: "Registration successful!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error" });
  }
});

// ------------------ MENTOR APPLY ------------------
app.post("/api/mentor-apply", upload.single("resume"), async (req, res) => {
  const { name, email, phone, expertise, experience, message } = req.body;
  if (!req.file) return res.status(400).json({ success: false, message: "Resume is required" });

  const resume = req.file.filename;
  try {
    const [result] = await db.query(
      "INSERT INTO mentor_applications (name, email, phone, expertise, experience, message, resume) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [name, email, phone, expertise, experience, message, resume]
    );
    res.json({ success: true, id: result.insertId, fileUrl: `/uploads/${resume}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB insert failed" });
  }
});

// ------------------ TESTIMONIALS ------------------
app.get("/api/testimonials", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM testimonials ORDER BY id DESC");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

app.post("/api/testimonials", async (req, res) => {
  const { name, role, review, verified } = req.body;
  try {
    const [result] = await db.query(
      "INSERT INTO testimonials (name, role, review, verified) VALUES (?, ?, ?, ?)",
      [name, role, review, verified]
    );
    res.json({ message: "Testimonial added successfully", id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// ------------------ MENTORS ------------------
app.get("/api/mentors", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM mentors");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------ DEMO REQUEST ------------------
app.post("/api/demo-request", async (req, res) => {
  const { name, email, phone, status, course, message } = req.body;
  try {
    const [result] = await db.query(
      "INSERT INTO demo_requests (name, email, phone, status, course, message) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, phone, status, course, message]
    );
    await sendMail(
      "deeplearneracademy@gmail.com",
      "📩 New Demo Request",
      `<h2>New Demo Request</h2>
       <p><strong>Name:</strong> ${name}</p>
       <p><strong>Email:</strong> ${email}</p>
       <p><strong>Phone:</strong> ${phone}</p>
       <p><strong>Status:</strong> ${status}</p>
       <p><strong>Course:</strong> ${course}</p>
       <p><strong>Message:</strong> ${message}</p>`
    );
    await sendMail(
      email,
      "✅ Your Demo Request Received",
      `<h2>Hi ${name},</h2>
       <p>Thank you for requesting a demo class with Deep learner Academy.</p>
       <p>We will reach out to you shortly regarding <strong>${course}</strong>.</p>
       <p>📞 Our team will contact you on: ${phone}</p>
       <br/><p>Best regards,<br/>Deep learner Academy</p>`
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database insert failed" });
  }
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));