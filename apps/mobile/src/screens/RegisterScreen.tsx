import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from "react-native";

export default function RegisterScreen({ navigation }: any) {
  const [name, setName]         = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function register() {
    if (!name || !email || !password) { setError("Fill all fields"); return; }
    if (password.length < 8) { setError("Password must be 8+ characters"); return; }
    setLoading(true); setError("");
    try {
      const res  = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/auth/register`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Registration failed");
      (global as any).accessToken = data.data.accessToken;
      navigation.reset({ index:0, routes:[{name:"Main"}] });
    } catch(err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }

  return (
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":"height"}>
      <ScrollView contentContainerStyle={s.container}>
        <Text style={s.title}>Create Account</Text>
        <Text style={s.subtitle}>Start your automated job search</Text>
        <View style={s.form}>
          {error ? <Text style={s.error}>{error}</Text> : null}
          <TextInput style={s.input} placeholder="Full Name" value={name} onChangeText={setName} autoCapitalize="words"/>
          <TextInput style={s.input} placeholder="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none"/>
          <TextInput style={s.input} placeholder="Password (8+ chars)" value={password} onChangeText={setPassword} secureTextEntry/>
          <TouchableOpacity style={[s.btn, loading && s.btnDisabled]} onPress={register} disabled={loading}>
            <Text style={s.btnText}>{loading ? "Creating…" : "Create Account"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={()=>navigation.navigate("Login")}>
            <Text style={s.link}>Already have an account? <Text style={s.linkBlue}>Sign in</Text></Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:{flexGrow:1,backgroundColor:"#F0F4FF",justifyContent:"center",padding:24},
  title:{fontSize:28,fontWeight:"800",color:"#1E3A8A",textAlign:"center",marginBottom:4},
  subtitle:{fontSize:14,color:"#64748B",textAlign:"center",marginBottom:32},
  form:{backgroundColor:"#fff",borderRadius:16,padding:20,shadowColor:"#000",shadowOpacity:0.08,shadowRadius:12,elevation:4},
  error:{color:"#DC2626",fontSize:13,marginBottom:12,textAlign:"center"},
  input:{borderWidth:1,borderColor:"#E2E8F0",borderRadius:10,padding:14,marginBottom:12,fontSize:15},
  btn:{backgroundColor:"#2563EB",borderRadius:10,padding:16,alignItems:"center",marginBottom:12},
  btnDisabled:{opacity:0.5},
  btnText:{color:"#fff",fontWeight:"700",fontSize:16},
  link:{textAlign:"center",color:"#94A3B8",fontSize:14},
  linkBlue:{color:"#2563EB",fontWeight:"600"},
});
