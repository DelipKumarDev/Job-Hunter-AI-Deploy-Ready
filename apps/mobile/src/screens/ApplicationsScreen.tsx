import React, { useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from "react-native";

const STATUS_COLOR: Record<string,string> = {
  PENDING:"#F3F4F6",APPLYING:"#DBEAFE",APPLIED:"#D1FAE5",
  INTERVIEW:"#FEF3C7",OFFER:"#EDE9FE",REJECTED:"#FEE2E2",
};
const STATUS_TEXT: Record<string,string> = {
  PENDING:"⏳ Pending",APPLYING:"🤖 Applying",APPLIED:"✅ Applied",
  INTERVIEW:"🎯 Interview",OFFER:"🎉 Offer!",REJECTED:"❌ Rejected",
};

export default function ApplicationsScreen() {
  const [apps, setApps]   = useState<any[]>([]);
  const [load, setLoad]   = useState(true);

  useEffect(() => {
    fetch("/api/v1/applications")
      .then(r => r.json()).then(d => setApps(d.data ?? []))
      .catch(()=>{}).finally(()=>setLoad(false));
  }, []);

  if (load) return <View style={s.center}><ActivityIndicator size="large" color="#2563EB"/></View>;

  return (
    <View style={s.container}>
      <Text style={s.title}>Applications ({apps.length})</Text>
      <FlatList data={apps} keyExtractor={a=>a.id}
        renderItem={({item:a})=>(
          <View style={s.card}>
            <View style={s.row}>
              <Text style={s.jobTitle} numberOfLines={1}>{a.jobListing?.title ?? "—"}</Text>
              <View style={[s.badge,{backgroundColor:STATUS_COLOR[a.status]??"#F3F4F6"}]}>
                <Text style={s.badgeText}>{STATUS_TEXT[a.status]??a.status}</Text>
              </View>
            </View>
            <Text style={s.company}>{a.jobListing?.company ?? "—"}</Text>
            {a.appliedAt && <Text style={s.date}>Applied {new Date(a.appliedAt).toLocaleDateString()}</Text>}
          </View>
        )}
        ListEmptyComponent={<Text style={s.empty}>No applications yet.</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:"#F9FAFB"},
  center:{flex:1,justifyContent:"center",alignItems:"center"},
  title:{fontSize:20,fontWeight:"700",color:"#111827",padding:20,paddingBottom:12},
  card:{backgroundColor:"#fff",marginHorizontal:16,marginBottom:10,padding:16,borderRadius:12,
        shadowColor:"#000",shadowOpacity:0.05,shadowRadius:6,elevation:1},
  row:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",marginBottom:4},
  jobTitle:{fontSize:15,fontWeight:"600",color:"#111827",flex:1,marginRight:8},
  company:{fontSize:13,color:"#374151",marginBottom:2},
  date:{fontSize:12,color:"#9CA3AF"},
  badge:{paddingHorizontal:8,paddingVertical:3,borderRadius:100},
  badgeText:{fontSize:11,fontWeight:"600"},
  empty:{textAlign:"center",color:"#9CA3AF",marginTop:60,fontSize:15},
});
