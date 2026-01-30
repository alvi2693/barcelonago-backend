import express from "express";
import cors from "cors";
import contactRoutes from "./routes/contact";
import "./db"; // inicializa la DB

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("🚀 BarcelonaGo Backend is running");
});

app.use(contactRoutes);

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
