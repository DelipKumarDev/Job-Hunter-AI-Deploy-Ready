import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";

export default function LoginScreen({ navigation }: any) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function login() {
    if (!email || !password) { setError("Please fill all fields"); return; }
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/auth/login`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Login failed");
      (global as any).accessToken = data.data.accessToken;
      navigation.reset({ index:0, routes:[{name:"Main"}] });
    } catch(err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS==="ios"?"padding":"height"}>
      <Text style={s.logo}>🤖</Text>
      <Text style={s.title}>Job Hunter AI</Text>
      <Text style={s.subtitle}>Automated job search, powered by AI</Text>
      <View style={s.form}>
        {error ? <Text style={s.error}>{error}</Text> : null}
        <TextInput style={s.input} placeholder="Email" value={email} onChangeText={setEmail}
          keyboardType="email-address" autoCapitalize="none" autoComplete="email"/>
        <TextInput style={s.input} placeholder="Password" value={password} onChangeText={setPassword}
          secureTextEntry autoComplete="password"/>
        <TouchableOpacity style={[s.btn, loading && s.btnDisabled]} onPress={login} disabled={loading}>
          <Text style={s.btnText}>{loading ? "Signing in…" : "Sign In"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={()=>navigation.navigate("Register")}>
          <Text style={s.link}>No account? <Text style={s.linkBlue}>Create one</Text></Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:"#F0F4FF",justifyContent:"center",padding:24},
  logo:{fontSize:56,textAlign:"center",marginBottom:8},
  title:{fontSize:28,fontWeight:"800",color:"#1E3A8A",textAlign:"center"},
  subtitle:{fontSize:14,color:"#64748B",textAlign:"center",marginBottom:32},
  form:{backgroundColor:"#fff",borderRadius:16,padding:20,
        shadowColor:"#000",shadowOpacity:0.08,shadowRadius:12,elevation:4},
  error:{color:"#DC2626",fontSize:13,marginBottom:12,textAlign:"center"},
  input:{borderWidth:1,borderColor:"#E2E8F0",borderRadius:10,padding:14,marginBottom:12,fontSize:15},
  btn:{backgroundColor:"#2563EB",borderRadius:10,padding:16,alignItems:"center",marginBottom:12},
  btnDisabled:{opacity:0.5},
  btnText:{color:"#fff",fontWeight:"700",fontSize:16},
  link:{textAlign:"center",color:"#94A3B8",fontSize:14},
  linkBlue:{color:"#2563EB",fontWeight:"600"},
});
