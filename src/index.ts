import express from "express";
import cors from "cors";
import contactRoutes from "./routes/contact";
import reservationRoutes from "./routes/reservations";
import { initDb } from "./db";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("🚀 BCN Rooms Backend is running");
});

app.use(contactRoutes);
app.use(reservationRoutes);

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});