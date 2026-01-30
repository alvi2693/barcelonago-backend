import express from "express";
import cors from "cors";
import contactRoutes from "./routes/contact";
import "./db";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("BarcelonaGo backend running 🚀");
});

app.use("/contact", contactRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
