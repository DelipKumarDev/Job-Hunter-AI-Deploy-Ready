import React, { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";

interface Job { id: string; title: string; company: string; location: string; totalScore: number; }

export default function JobsScreen() {
  const [jobs, setJobs]     = useState<Job[]>([]);
  const [loading, setLoad]  = useState(true);

  useEffect(() => {
    fetch("/api/v1/jobs?limit=50")
      .then(r => r.json())
      .then(d => setJobs(d.data?.items ?? []))
      .catch(() => {})
      .finally(() => setLoad(false));
  }, []);

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color="#2563EB" /></View>;

  return (
    <View style={s.container}>
      <Text style={s.title}>Discovered Jobs ({jobs.length})</Text>
      <FlatList
        data={jobs}
        keyExtractor={j => j.id}
        renderItem={({ item: j }) => (
          <TouchableOpacity style={s.card}>
            <View style={s.row}>
              <Text style={s.jobTitle} numberOfLines={1}>{j.title}</Text>
              <View style={[s.badge, { backgroundColor: j.totalScore >= 80 ? "#D1FAE5" : "#FEF3C7" }]}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: j.totalScore >= 80 ? "#065F46" : "#92400E" }}>
                  {j.totalScore}%
                </Text>
              </View>
            </View>
            <Text style={s.company}>{j.company}</Text>
            <Text style={s.location}>📍 {j.location}</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={s.empty}>No jobs found yet. Trigger a scan!</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  center:    { flex: 1, justifyContent: "center", alignItems: "center" },
  title:     { fontSize: 20, fontWeight: "700", color: "#111827", padding: 20, paddingBottom: 12 },
  card:      { backgroundColor: "#fff", marginHorizontal: 16, marginBottom: 10, padding: 16,
               borderRadius: 12, shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 6, elevation: 1 },
  row:       { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  jobTitle:  { fontSize: 15, fontWeight: "600", color: "#111827", flex: 1, marginRight: 8 },
  company:   { fontSize: 13, color: "#374151", marginBottom: 2 },
  location:  { fontSize: 12, color: "#9CA3AF" },
  badge:     { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 100 },
  empty:     { textAlign: "center", color: "#9CA3AF", marginTop: 60, fontSize: 15 },
});
