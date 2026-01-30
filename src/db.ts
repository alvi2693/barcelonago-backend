export type Lead = {
  name: string;
  email: string;
  message: string;
  created_at: string;
};

// Simulación de almacenamiento (solo para desarrollo / MVP)
const leads: Lead[] = [];

export function saveLead(lead: Omit<Lead, "created_at">) {
  const newLead: Lead = {
    ...lead,
    created_at: new Date().toISOString(),
  };

  leads.push(newLead);

  console.log("📩 New lead saved:", newLead);

  return newLead;
}
