import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from "react-native";

export default function DashboardScreen() {
  const [stats, setStats]       = useState({ jobs: 0, applied: 0, interviews: 0, offers: 0 });
  const [refreshing, setRef]    = useState(false);

  async function load() {
    setRef(true);
    try {
      const res = await fetch("/api/v1/discovery/status", {
        headers: { Authorization: `Bearer ${global.accessToken ?? ""}` },
      });
      if (res.ok) {
        const d = await res.json();
        setStats(d.data?.stats ?? stats);
      }
    } catch { /* offline — show cached */ }
    finally { setRef(false); }
  }

  useEffect(() => { load(); }, []);

  const cards = [
    { label: "Jobs Found",    value: stats.jobs,       color: "#3B82F6" },
    { label: "Applied",       value: stats.applied,    color: "#10B981" },
    { label: "Interviews",    value: stats.interviews, color: "#F59E0B" },
    { label: "Offers",        value: stats.offers,     color: "#8B5CF6" },
  ];

  return (
    <ScrollView style={s.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}>
      <Text style={s.greeting}>Job Hunter AI 🤖</Text>
      <Text style={s.subtitle}>Your automated job search dashboard</Text>
      <View style={s.grid}>
        {cards.map(c => (
          <View key={c.label} style={[s.card, { borderLeftColor: c.color }]}>
            <Text style={[s.cardValue, { color: c.color }]}>{c.value}</Text>
            <Text style={s.cardLabel}>{c.label}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity style={s.scanBtn} onPress={() => { /* trigger scan */ }}>
        <Text style={s.scanBtnText}>🔍  Scan for Jobs Now</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F9FAFB", padding: 20 },
  greeting:    { fontSize: 24, fontWeight: "700", color: "#111827", marginTop: 12 },
  subtitle:    { fontSize: 14, color: "#6B7280", marginBottom: 24 },
  grid:        { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 24 },
  card:        { width: "47%", backgroundColor: "#fff", borderRadius: 12, padding: 16,
                 borderLeftWidth: 4, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  cardValue:   { fontSize: 32, fontWeight: "800" },
  cardLabel:   { fontSize: 12, color: "#6B7280", marginTop: 4 },
  scanBtn:     { backgroundColor: "#2563EB", borderRadius: 12, padding: 16, alignItems: "center" },
  scanBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
