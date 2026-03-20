import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text } from 'react-native';

// Screen imports
import DashboardScreen   from '../screens/DashboardScreen';
import JobsScreen        from '../screens/JobsScreen';
import ApplicationsScreen from '../screens/ApplicationsScreen';
import ProfileScreen     from '../screens/ProfileScreen';

// Auth
import LoginScreen    from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';

const Tab   = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const icons: Record<string, string> = {
    Dashboard: '🏠', Jobs: '💼', Applications: '📋', Profile: '👤',
  };
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{icons[name] ?? '•'}</Text>;
}

function MainTabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false, tabBarStyle: { paddingBottom: 4 } }}>
      <Tab.Screen name="Dashboard"    component={DashboardScreen}    options={{ tabBarIcon: p => <TabIcon name="Dashboard"    {...p} /> }} />
      <Tab.Screen name="Jobs"         component={JobsScreen}         options={{ tabBarIcon: p => <TabIcon name="Jobs"         {...p} /> }} />
      <Tab.Screen name="Applications" component={ApplicationsScreen} options={{ tabBarIcon: p => <TabIcon name="Applications" {...p} /> }} />
      <Tab.Screen name="Profile"      component={ProfileScreen}      options={{ tabBarIcon: p => <TabIcon name="Profile"      {...p} /> }} />
    </Tab.Navigator>
  );
}

export default function Navigation() {
  // TODO: check auth state from store
  const isAuthenticated = false;
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isAuthenticated ? (
          <Stack.Screen name="Main" component={MainTabs} />
        ) : (
          <>
            <Stack.Screen name="Login"    component={LoginScreen} />
            <Stack.Screen name="Register" component={RegisterScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
