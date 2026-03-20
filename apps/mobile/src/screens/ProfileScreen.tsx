import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

export default function ProfileScreen() {
  return (
    <View style={s.container}>
      <View style={s.avatar}><Text style={s.avatarText}>JD</Text></View>
      <Text style={s.name}>Job Seeker</Text>
      <Text style={s.email}>user@example.com</Text>
      <View style={s.divider}/>
      {[["📄","Resume","Manage your resume"],["⚙️","Preferences","Job search settings"],["🔔","Notifications","Alert preferences"],["🔒","Security","Password & 2FA"]].map(([icon,label,desc])=>(
        <TouchableOpacity key={label} style={s.row}>
          <Text style={s.icon}>{icon}</Text>
          <View style={s.rowText}><Text style={s.rowLabel}>{label}</Text><Text style={s.rowDesc}>{desc}</Text></View>
          <Text style={s.chevron}>›</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={s.logoutBtn}>
        <Text style={s.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:"#F9FAFB",padding:20},
  avatar:{width:80,height:80,borderRadius:40,backgroundColor:"#2563EB",alignSelf:"center",
          justifyContent:"center",alignItems:"center",marginTop:20},
  avatarText:{fontSize:28,fontWeight:"700",color:"#fff"},
  name:{textAlign:"center",fontSize:20,fontWeight:"700",color:"#111827",marginTop:12},
  email:{textAlign:"center",fontSize:14,color:"#6B7280",marginBottom:24},
  divider:{height:1,backgroundColor:"#E5E7EB",marginBottom:8},
  row:{flexDirection:"row",alignItems:"center",backgroundColor:"#fff",padding:16,
       borderRadius:12,marginBottom:8,shadowColor:"#000",shadowOpacity:0.03,shadowRadius:4,elevation:1},
  icon:{fontSize:20,marginRight:12},
  rowText:{flex:1},
  rowLabel:{fontSize:15,fontWeight:"600",color:"#111827"},
  rowDesc:{fontSize:12,color:"#9CA3AF"},
  chevron:{fontSize:20,color:"#D1D5DB"},
  logoutBtn:{marginTop:24,backgroundColor:"#FEE2E2",borderRadius:12,padding:16,alignItems:"center"},
  logoutText:{color:"#DC2626",fontWeight:"700",fontSize:15},
});
