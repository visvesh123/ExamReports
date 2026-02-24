import express from "express";
import { createClient } from "@supabase/supabase-js";
import Handlebars from "handlebars";
import puppeteer from "puppeteer";
import dayjs from "dayjs";
import JSZip from "jszip";   // add at top

const app = express();
app.use(express.json());

Handlebars.registerHelper("eq", function (a, b) {
    return a === b;
  });
 
// ENV
const SUPABASE_URL = "https://ibocbkptpaxeoxusehyy.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlib2Nia3B0cGF4ZW94dXNlaHl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NzQzNjI3NSwiZXhwIjoyMDczMDEyMjc1fQ.RjGZcSu7928rr96E46lAYc7DvTEDOGqT5HKDn_Zk2XU";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Please set SUPABASE_URL and SUPABASE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// -------------------------------------------------------------------
// 🔶 HTML TEMPLATE (NO SIGNATURE — HAS STATUS COLUMN)
// -------------------------------------------------------------------
const htmlTemplate = `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 28px; color:#000; }
  .header { text-align:center; }
  .header h2 { margin:0; font-size:18px; }
  .header h3 { margin:0; font-size:14px; }
  .meta { margin-top:8px; text-align:center; font-size:12px; line-height:18px; }

  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th, td { border:1px solid #000; padding:6px 8px; }
  th { background:#f2f2f2; }

  .footer { margin-top:18px; font-size:12px; }
</style>
</head>
<body>

  <div class="header">
    <h2>MAHINDRA UNIVERSITY</h2>
    <h3>QTAP - EXAM ATTENDANCE REPORT</h3>

    <div class="meta">
      {{program}} Minor 1 Examinations, {{exam_year}} <br>
       {{course_code}} ({{course_name}}) <br>
       {{exam_date}} ({{start_time}} to {{end_time}}) <br>
      
    </div>
    <h3>  {{venue}} </h3>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:8%;">S.No</th>
        <th style="width:22%;">H.T. No</th>
        <th>Student Name</th>
        <th style="width:18%;">Status</th>
      </tr>
    </thead>

    <tbody>
    {{#each students}}
      <tr>
        <td>{{serial}}</td>
        <td>{{ht_no}}</td>
        <td>{{full_name}}</td>
        <td style="{{#if (eq status "Absent")}}color:red; font-weight:bold;{{/if}}">
  {{status}}
</td>
      </tr>
    {{/each}}
    </tbody>
  </table>

  <div class="footer">
    <p>Total No of students Present: <b>{{present_count}}</b></p>
    <p>Total No of Absentees: <b>{{absent_count}}</b></p>

    <p><b>Name and Sign of Invigilators:</b> {{invigilators_text}}</p>
    <p><b>Name and Sign of Faculties:</b> ____________________________</p>
  </div>

</body>
</html>
`;

// -------------------------------------------------------------------
// 🔶 Fetch exam dataset
// -------------------------------------------------------------------
async function fetchExamDataset(examId) {
  const { data: exam, error: examErr } = await supabase
    .from("examinations")
    .select("*")
    .eq("exam_id", examId)
    .single();

  if (examErr || !exam) throw new Error("Exam not found");

  // Course
  let course = null;
  if (exam.course_id) {
    const { data, error } = await supabase
      .from("courses")
      .select("*")
      .eq("course_id", exam.course_id)
      .single();
    if (error) throw new Error("Course fetch error");
    course = data;
  }

  // Attendance
  const { data: attendanceRows, error: attErr } = await supabase
    .from("exam_attendance")
    .select(`attendance_id, student_id, status `)
    .eq("exam_id", examId);

  if (attErr) throw new Error("Attendance fetch error");

  const studentIds = [...new Set(attendanceRows.map(r => r.student_id))];

  // Students
  let students = [];
  if (studentIds.length) {
    const { data, error } = await supabase
      .from("students")
      .select("student_id, ht_no, full_name")
      .in("student_id", studentIds);

    if (error) throw new Error("Students fetch error");
    students = data;
  }

  const studentById = Object.fromEntries(
    students.map(s => [s.student_id, s])
  );

  // Invigilators
  const { data: invMap } = await supabase
    .from("exam_invigilators")
    .select("invigilator_id, exam_id");

  const invIds = (invMap || [])
    .filter(r => r.exam_id === examId)
    .map(r => r.invigilator_id);

  let invigilators = [];
  if (invIds.length) {
    const { data } = await supabase
      .from("invigilators")
      .select("invigilator_id, name, designation")
      .in("invigilator_id", invIds);
    invigilators = data || [];
  }

  return { exam, course, attendanceRows, studentById, invigilators };
}

// -------------------------------------------------------------------
// 🔶 MAIN ROUTE: Generate PDF
// -------------------------------------------------------------------
app.get("/generate-exam-report", async (req, res) => {
  try {
    const examId = Number(req.query.exam_id || req.query.id);
    if (!examId) return res.status(400).send("Missing exam_id");

    const {
      exam,
      course,
      attendanceRows,
      studentById,
      invigilators
    } = await fetchExamDataset(examId);

    // Build rows
    let students = attendanceRows.map((row, index) => {
      const s = studentById[row.student_id] || {};
      return {
        serial: index + 1,
        ht_no: s.ht_no || "",
        full_name: s.full_name || "",
        status: row.status || ""
      };
    });

    // Sort by HT number
    students.sort((a, b) =>
      (a.ht_no || "").localeCompare(b.ht_no || "", undefined, { numeric: true })
    );

    const present_count = students.filter(s => s.status.toLowerCase() === "present").length;
    const absent_count = students.length - present_count;

    const invigilators_text = invigilators
      .map(i => `${i.name}${i.designation ? " (" + i.designation + ")" : ""}`)
      .join(", ");

    // Build template context
    const ctx = {
      program: exam.program ?? "",
      exam_year: dayjs(exam.exam_date).year(),
      course_code: course?.course_code ?? "",
      course_name: course?.course_name ?? "",
      exam_date: dayjs(exam.exam_date).format("DD.MM.YYYY"),
      start_time: exam.start_time ?? "",
      end_time: exam.end_time ?? "",
      venue: exam.venue ?? "",
      students,
      present_count,
      absent_count,
      invigilators_text
    };

    const hb = Handlebars.compile(htmlTemplate);
    const html = hb(ctx);

    const browser = await puppeteer.launch({
    headless : "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20px", bottom: "20px", left: "18px", right: "18px" }
    });

    await browser.close();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="attendance_${examId}.pdf"`,
      "Content-Length": pdfBuffer.length
    });

    return res.send(pdfBuffer);

  } catch (err) {
    console.error(err);
    return res.status(500).send({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Attendance PDF generator running on port ${PORT}`)
);


app.get("/generate-by-venue", async (req, res) => {
    try {
      const venue = req.query.venue;
      const date = req.query.date;
      const time = req.query.time;
  
      if (!venue || !date) {
        return res.status(400).send("Missing venue or date");
      }
  
      // 1️⃣ Fetch all exams from same venue + date
      const { data: exams, error } = await supabase
        .from("examinations")
        .select(`exam_id, venue, exam_date, end_time , courses (
      course_id,
      course_name,
      course_code
    )`)
        .eq("venue", venue)
        .eq("exam_date", date)
        .eq("end_time", time)

    console.log(exams)
     const { data: courses } = await supabase
        .from("courses")
        .select("*")
        .in("exam_id", exams.map(e => e.course_id));
       


      if (error || !exams.length) {
        return res.status(404).send("No exams found for this venue & date.");
      }
    
      const zip = new JSZip();
  
      // 2️⃣ Loop through all exams at that venue on that date
      for (const exam of exams) {
   
        const examId = exam.exam_id;
        const course_code = exam.courses.course_code
        const course_name = exam.courses.course_name
  
        // fetch data
        const {
          exam: ex,
          course,
          attendanceRows,
          studentById,
          invigilators
        } = await fetchExamDataset(examId);
  
        // prepare students
        let students = attendanceRows.map((row, index) => {
          const s = studentById[row.student_id] || {};
          return {
            serial: index + 1,
            ht_no: s.ht_no || "",
            full_name: s.full_name || "",
            status: row.status || ""
          };
        });
  
        students.sort((a, b) =>
          (a.ht_no || "").localeCompare(b.ht_no || "", undefined, {
            numeric: true
          })
        );
  
        const present_count = students.filter(
          (s) => s.status.toLowerCase() === "present"
        ).length;
  
        const absent_count = students.length - present_count;
  
        const invigilators_text = invigilators
          .map(
            (i) =>
              `${i.name}${i.designation ? " (" + i.designation + ")" : ""}`
          )
          .join(", ");
  
        // template context
        const ctx = {
          program: ex.program ?? "",
          exam_year: dayjs(ex.exam_date).year(),
          course_code: course?.course_code ?? "",
          course_name: course?.course_name ?? "",
          exam_date: dayjs(ex.exam_date).format("DD.MM.YYYY"),
          start_time: ex.start_time ?? "",
          end_time: ex.end_time ?? "",
          venue: ex.venue ?? "",
          students,
          present_count,
          absent_count,
          invigilators_text
        };
  
        const html = Handlebars.compile(htmlTemplate)(ctx);
  
        // generate PDF
        const browser = await puppeteer.launch({
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "networkidle0" });
        const pdfBuffer = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: {
            top: "20px",
            bottom: "20px",
            left: "18px",
            right: "18px",
          },
        });
        await browser.close();
  
        // 3️⃣ Add each PDF to ZIP
        zip.file(`${exam.venue}_${course_code} - ${course_name}.pdf`, pdfBuffer);
      }
  
      // 4️⃣ Generate ZIP
      const zipFile = await zip.generateAsync({ type: "nodebuffer" });
  
      res.set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${venue}_${date}_reports.zip"`,
      });
  
      return res.send(zipFile);
    } catch (err) {
      console.error(err);
      return res.status(500).send({ error: err.message });
    }
  });
  