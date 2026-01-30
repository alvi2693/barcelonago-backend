import express from "express";
import cors from "cors";
import contactRouter from "./routes/contact";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/contact", contactRouter);

// ⚠️ Render usa SU puerto
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
